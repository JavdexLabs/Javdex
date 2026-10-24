import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { appendLocalModelDiagnostic, gpuDiagnosticFailure, gpuLoaderFailure, gpuMemoryFailure, localModelProcessEnvironment, stopLocalModelProcess } from './processRunner'
import type { AiRuntimePaths } from './runtimeInstaller'
import { localTextTranslationPrompt, localTranslationSettings } from './localTranslation'
import { cpuExecution, executionUsesGpu, LocalGpuFailure, reportLocalExecution, selectLocalExecution, type LocalExecution } from './runtimeAcceleration'

export interface LocalTextInferenceOptions {
  spawn?: typeof spawn
  request?: typeof fetch
  port?: () => Promise<number>
  log?: (stage: string, value: unknown) => void
  /** Isolated diagnostics only; never forwarded to product snapshots. */
  nativeDiagnostic?: (text: string) => void
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
type TextPaths = Pick<AiRuntimePaths, 'translator' | 'translationModel' | 'translationModelId' | 'acceleration'>
export function createLocalTextInference(paths: TextPaths, options: LocalTextInferenceOptions = {}) {
  let server: ReturnType<typeof createTextServer> | null = null
  let execution: LocalExecution | null = null
  let initializing: Promise<void> | null = null, fallback: Promise<void> | null = null
  let closed = false
  async function invoke<T>(signal: AbortSignal, action: (value: ReturnType<typeof createTextServer>) => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    if (closed) throw new Error('本地翻译引擎已关闭')
    if (!server) {
      initializing ??= (async () => {
        const selected = await selectLocalExecution(paths.translator, paths.translationModel, 'translation', paths.acceleration)
        if (closed) { selected.release(); throw new Error('本地翻译引擎已关闭') }
        execution = selected
        server = createTextServer(paths, options, paths.acceleration ? selected : undefined)
      })().finally(() => { initializing = null })
      await initializing
    }
    if (fallback) await fallback
    const attempted = server!
    try { return await action(attempted) }
    catch (cause) {
      if (closed || signal.aborted || !(cause instanceof LocalGpuFailure)) throw cause
      if (server === attempted && !fallback) {
        fallback = (async () => {
          await attempted.close(); execution?.release()
          execution = cpuExecution(paths.translator, 'translation', paths.acceleration, `${cause.message}，已自动回退 CPU`)
          if (closed) throw new Error('本地翻译引擎已关闭')
          server = createTextServer(paths, options, execution)
        })().finally(() => { fallback = null })
      }
      if (fallback) await fallback
      signal.throwIfAborted()
      return action(server!)
    }
  }
  return {
    ready: (signal: AbortSignal) => invoke(signal, value => value.ready(signal)),
    translateContent: (prompt: string, signal: AbortSignal, maxTokens: number) => invoke(signal, value => value.translateContent(prompt, signal, maxTokens)),
    translateText: (text: string, signal: AbortSignal) => invoke(signal, value => value.translateText(text, signal)),
    async close(): Promise<void> {
      closed = true
      const stopping = server?.close()
      await initializing?.catch(() => {}); await fallback?.catch(() => {})
      await stopping; await server?.close(); execution?.release(); server = null
    }
  }
}
function createTextServer(paths: TextPaths, options: LocalTextInferenceOptions, execution?: LocalExecution) {
  const model = paths.translationModelId ?? 'qwen3'
  const settings = localTranslationSettings(model)
  const request = options.request ?? fetch
  let server: ChildProcess | null = null
  let endpoint = ''
  let key = ''
  let starting: Promise<void> | null = null
  let lifetime = new AbortController()
  let diagnostic = '', nativeGpuFailure = false
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
        diagnostic = ''; nativeGpuFailure = false
        const child = (options.spawn ?? spawn)(execution?.executable ?? paths.translator, ['-m', paths.translationModel, '--host', '127.0.0.1', '--port', String(port),
          '--offline', '--no-agent', '--no-webui', '--no-slots', '-c', '8192', '-np', '1', '-t', threads, '--prio', '-1', ...settings.serverArguments, ...(execution?.args ?? [])], {
          windowsHide: true, shell: false, stdio: execution ? ['ignore', 'ignore', 'pipe'] : 'ignore', env: { ...localModelProcessEnvironment(), ...execution?.env, LLAMA_API_KEY: token }
        })
        child.stderr?.on('data', (chunk: Buffer) => { diagnostic = appendLocalModelDiagnostic(diagnostic, chunk.toString()) })
        server = child
        let failed = false
        child.once('error', (error: NodeJS.ErrnoException) => { failed = true; nativeGpuFailure = error.code === 'ENOENT' })
        child.once('exit', code => { failed = true; nativeGpuFailure ||= gpuLoaderFailure(code) })
        child.once('close', () => { failed = true; if (server === child) { server = null; endpoint = ''; key = '' } })
        const abort = (): void => { void stopLocalModelProcess(child) }
        generation.signal.addEventListener('abort', abort, { once: true })
        child.once('close', () => generation.signal.removeEventListener('abort', abort))
        const address = `http://127.0.0.1:${port}`
        const startupFailure = (): Error => executionUsesGpu(execution) && (nativeGpuFailure || gpuDiagnosticFailure(diagnostic))
          ? new LocalGpuFailure(gpuMemoryFailure(diagnostic) ? 'GPU 显存分配失败' : 'GPU 运行库启动失败') : new Error('离线中文翻译运行库启动失败')
        let initialized = false
        try {
          for (let attempt = 0; attempt < 180; attempt++) {
            generation.signal.throwIfAborted()
            if (failed) throw startupFailure()
            try {
              // /health is public; authenticate against /v1/models to verify the owned server.
              const response = await request(`${address}/v1/models`, { headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.any([generation.signal, AbortSignal.timeout(1000)]) })
              if (response.ok) {
                if (failed) throw startupFailure()
                options.nativeDiagnostic?.(diagnostic)
                if (execution && !reportLocalExecution(paths.acceleration, 'translation', execution, diagnostic)) throw new LocalGpuFailure('GPU 未启用')
                endpoint = address; key = token; initialized = true; return
              }
            } catch (cause) {
              if (cause instanceof LocalGpuFailure) throw cause
              if (failed) throw startupFailure()
              // Model loading can take time; no transcript is sent during startup.
            }
            await delay(500, undefined, { signal: generation.signal })
          }
          if (executionUsesGpu(execution)) throw new LocalGpuFailure('GPU 初始化超时')
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
        ...settings.request, stream: false }) }).catch(cause => {
      if (executionUsesGpu(execution) && !signal.aborted && (nativeGpuFailure || gpuDiagnosticFailure(diagnostic))) throw new LocalGpuFailure(gpuMemoryFailure(diagnostic) ? 'GPU 显存分配失败' : 'GPU 推理失败')
      throw cause
    })
    const raw = await response.text()
    options.log?.('翻译原始响应', { model, status: response.status, response: raw })
    if (!response.ok) {
      if (executionUsesGpu(execution) && gpuDiagnosticFailure(diagnostic)) throw new LocalGpuFailure(gpuMemoryFailure(diagnostic) ? 'GPU 显存分配失败' : 'GPU 推理失败')
      throw new Error('离线中文翻译失败')
    }
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
