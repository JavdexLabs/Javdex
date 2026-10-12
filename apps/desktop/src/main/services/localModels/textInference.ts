import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { localModelProcessEnvironment, stopLocalModelProcess } from './processRunner'
import type { AiRuntimePaths } from './runtimeInstaller'
import { localTextTranslationPrompt, localTranslationSettings } from './localTranslation'

export interface LocalTextInferenceOptions {
  spawn?: typeof spawn
  request?: typeof fetch
  port?: () => Promise<number>
  log?: (stage: string, value: unknown) => void
}
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
export function createLocalTextInference(paths: Pick<AiRuntimePaths, 'translator' | 'translationModel' | 'translationModelId'>, options: LocalTextInferenceOptions = {}) {
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
          windowsHide: true, shell: false, stdio: 'ignore', env: { ...localModelProcessEnvironment(), LLAMA_API_KEY: token }
        })
        server = child
        let failed = false
        child.once('error', () => { failed = true })
        child.once('exit', () => { failed = true })
        child.once('close', () => { failed = true; if (server === child) { server = null; endpoint = ''; key = '' } })
        const abort = (): void => { void stopLocalModelProcess(child) }
        generation.signal.addEventListener('abort', abort, { once: true })
        child.once('close', () => generation.signal.removeEventListener('abort', abort))
        const address = `http://127.0.0.1:${port}`
        let initialized = false
        try {
          for (let attempt = 0; attempt < 180; attempt++) {
            generation.signal.throwIfAborted()
            if (failed) throw new Error('离线中文翻译运行库启动失败')
            try {
              // /health is public; authenticate against /v1/models to verify the owned server.
              const response = await request(`${address}/v1/models`, { headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.any([generation.signal, AbortSignal.timeout(1000)]) })
              if (response.ok) { endpoint = address; key = token; initialized = true; return }
            } catch { /* Model loading can take time; no transcript is sent during startup. */ }
            await delay(500, undefined, { signal: generation.signal })
          }
          throw new Error('离线中文翻译模型加载超时')
        } finally {
          if (!initialized && server === child) {
            await stopLocalModelProcess(child)
            if (server === child) { server = null; endpoint = ''; key = '' }
          }
        }
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
    options.log?.('翻译请求', { model, prompt, maxTokens })
    await ready(signal)
    const response = await request(`${endpoint}/v1/chat/completions`, { method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(90000)]),
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens,
        ...settings.request, stream: false }) })
    const raw = await response.text()
    options.log?.('翻译原始响应', { model, status: response.status, response: raw })
    if (!response.ok) throw new Error('离线中文翻译失败')
    const value = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }> }
    const text = value.choices?.[0]?.message?.content
    if (typeof text !== 'string' || text.length > 6000 || value.choices?.[0]?.finish_reason === 'length') {
      throw new Error('中文译文不完整，请重试')
    }
    const output = text.trim()
    if (!output) throw new Error('中文译文不完整，请重试')
    return output
  }
  return {
    ready, translateContent,
    translateText(text: string, signal: AbortSignal): Promise<string> {
      return translateContent(localTextTranslationPrompt(model, text), signal, 1536)
    },
    async close(): Promise<void> {
      const child = server
      lifetime.abort(); lifetime = new AbortController()
      server = null; endpoint = ''; key = ''
      if (child) await stopLocalModelProcess(child)
    }
  }
}
