import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runSubtitleProcess, subtitleProcessEnvironment } from './processRunner'
import type { AiRuntimePaths } from './runtimeInstaller'
import { parseWhisperCues, SUBTITLE_CONTEXT_SECONDS, type SubtitleCue } from './subtitleDocument'
import { localSubtitleTranslationPrompt, localTextTranslationPrompt, localTranslationSettings, localTranslationOutput } from './localTranslation'

export interface SubtitleAudioStream { index: number; identity: string }
async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(error => error ? reject(error) : resolve((address as net.AddressInfo).port))
    })
  })
}
export { subtitleProcessEnvironment } from './processRunner'
export function translationPrompt(japanese: string, context: string[] = []): string {
  return localSubtitleTranslationPrompt('qwen3', japanese, context)
}
export function createOfflineSubtitleInference(paths: AiRuntimePaths, workRoot: string, options: {
  spawn?: typeof spawn; request?: typeof fetch; port?: typeof unusedPort
} = {}) {
  const model = paths.translationModelId ?? 'qwen3'
  const settings = localTranslationSettings(model)
  const request = options.request ?? fetch
  let server: ChildProcess | null = null
  let endpoint = ''
  let key = ''
  let starting: Promise<void> | null = null
  let lifetime = new AbortController()
  const threads = String(Math.max(1, Math.min(6, Math.floor(os.availableParallelism() / 2))))
  async function ready(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (server && !starting) return
    if (!starting) {
      const generation = lifetime
      starting = (async () => {
        const port = await (options.port ?? unusedPort)()
        generation.signal.throwIfAborted()
        const token = randomBytes(32).toString('hex')
        const child = (options.spawn ?? spawn)(paths.translator, ['-m', paths.translationModel, '--host', '127.0.0.1', '--port', String(port),
          '--offline', '--no-agent', '--no-webui', '--no-slots', '-c', '8192', '-np', '1', '-t', threads, '--prio', '-1', ...settings.serverArguments], {
          windowsHide: true, shell: false, stdio: 'ignore', env: { ...subtitleProcessEnvironment(), LLAMA_API_KEY: token }
        })
        server = child
        let failed = false
        child.once('error', () => { failed = true })
        child.once('exit', () => { failed = true; if (server === child) { server = null; endpoint = ''; key = '' } })
        const abort = (): void => { child.kill() }
        generation.signal.addEventListener('abort', abort, { once: true })
        child.once('close', () => generation.signal.removeEventListener('abort', abort))
        const address = `http://127.0.0.1:${port}`
        for (let attempt = 0; attempt < 180; attempt++) {
          generation.signal.throwIfAborted()
          if (failed) throw new Error('离线中文翻译运行库启动失败')
          try {
            // /health is public; authenticate against /v1/models to verify the owned server.
            const response = await request(`${address}/v1/models`, { headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.any([generation.signal, AbortSignal.timeout(1000)]) })
            if (response.ok) { endpoint = address; key = token; return }
          } catch { /* Model loading can take time; no transcript is sent during startup. */ }
          await delay(500, undefined, { signal: generation.signal })
        }
        child.kill(); throw new Error('离线中文翻译模型加载超时')
      })().finally(() => { starting = null })
    }
    let abort: (() => void) | undefined
    try {
      await Promise.race([starting, new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason)
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })])
    } finally { if (abort) signal.removeEventListener('abort', abort) }
    signal.throwIfAborted()
  }
  async function translateContent(prompt: string, signal: AbortSignal, maxTokens: number): Promise<string> {
    await ready(signal)
    const response = await request(`${endpoint}/v1/chat/completions`, { method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(90000)]),
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens,
        ...settings.request, stream: false }) })
    if (!response.ok) throw new Error('离线中文翻译失败')
    const value = await response.json() as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }> }
    const text = value.choices?.[0]?.message?.content
    if (typeof text !== 'string' || text.length > 6000 || value.choices?.[0]?.finish_reason === 'length') {
      throw new Error('中文译文不完整，请重试')
    }
    const output = localTranslationOutput(model, text)
    if (!output) throw new Error('中文译文不完整，请重试')
    return output
  }
  return {
    translateText(text: string, signal: AbortSignal): Promise<string> {
      return translateContent(localTextTranslationPrompt(model, text), signal, 1536)
    },
    async probe(locator: string, expectedIndex: number, signal: AbortSignal): Promise<SubtitleAudioStream> {
      const value = JSON.parse(await runSubtitleProcess(paths.ffprobe, ['-v', 'error', '-show_entries',
        'stream=index,codec_type,codec_name,channels:stream_tags=language,title', '-of', 'json', locator], { signal, timeoutMs: 30000 }))
      const stream = Array.isArray(value.streams) ? value.streams.find((stream: Record<string, unknown>) => stream.index === expectedIndex && stream.codec_type === 'audio') : null
      if (!stream) throw new Error('无法匹配当前播放音轨，请重新选择音轨')
      return { index: expectedIndex, identity: JSON.stringify(stream) }
    },
    async recognize(locator: string, audioIndex: number, start: number, end: number, signal: AbortSignal): Promise<SubtitleCue[]> {
      if (!Number.isInteger(audioIndex) || audioIndex < 0 || !Number.isFinite(start) || !Number.isFinite(end)
        || start < 0 || end <= start || end - start > 30) throw new Error('音频识别区间无效')
      signal.throwIfAborted()
      await fs.mkdir(workRoot, { recursive: true })
      const directory = await fs.mkdtemp(path.join(workRoot, 'chunk-'))
      const wav = path.join(directory, 'audio.wav'), output = path.join(directory, 'recognized')
      const extractStart = Math.max(0, start - SUBTITLE_CONTEXT_SECONDS)
      try {
        await runSubtitleProcess(paths.ffmpeg, ['-nostdin', '-v', 'error', '-ss', String(extractStart), '-i', locator,
          '-t', String(end - extractStart + SUBTITLE_CONTEXT_SECONDS), '-map', `0:${audioIndex}`, '-vn', '-sn', '-dn',
          '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', wav], { signal, timeoutMs: 45000 })
        if ((await fs.stat(wav)).size > 4 * 1024 * 1024) throw new Error('音频提取结果超限')
        await runSubtitleProcess(paths.whisper, ['-m', paths.kotoba, '-f', wav, '-l', 'ja', '-ojf', '-of', output,
          '-t', threads, '-np', '-mc', '0', '--vad', '--vad-model', paths.vad], { signal, timeoutMs: 240000 })
        if ((await fs.stat(`${output}.json`)).size > 4 * 1024 * 1024) throw new Error('日语识别结果超限')
        return parseWhisperCues(JSON.parse(await fs.readFile(`${output}.json`, 'utf8')), extractStart, start, end)
      } finally { await fs.rm(directory, { recursive: true, force: true }) }
    },
    async translate(cues: SubtitleCue[], signal: AbortSignal, updated: (cues: SubtitleCue[]) => Promise<void>): Promise<SubtitleCue[]> {
      if (!cues.length) return []
      await ready(signal)
      const result = structuredClone(cues)
      for (let index = 0; index < result.length; index++) {
        signal.throwIfAborted()
        if (result[index].chinese) continue
        result[index].chinese = await translateContent(localSubtitleTranslationPrompt(model, result[index].japanese,
          result.slice(Math.max(0, index - 2), index).map(cue => cue.japanese)), signal, 768)
        await updated(structuredClone(result))
      }
      return result
    },
    async close(): Promise<void> {
      lifetime.abort(); lifetime = new AbortController()
      const child = server; server = null; endpoint = ''; key = ''
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 5000)
          child.once('close', () => { clearTimeout(timer); resolve() }); child.kill()
        })
      }
    }
  }
}
