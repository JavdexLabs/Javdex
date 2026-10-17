import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'

export class LocalModelProcessFailure extends Error {
  constructor(readonly tool: string, readonly exitCode: number | null, readonly gpuFailure = false) { super('本地模型运行库执行失败') }
}

export const gpuDiagnosticFailure = (text: string): boolean =>
  /out of (?:device )?memory|cuda(?: error|_error)|cublas.*(?:fail|error)|vulkan.*(?:fail|error)|VK_ERROR_|no (?:usable )?GPU|invalid device: (?:CUDA|Vulkan)|failed to (?:initialize|allocate).*?(?:CUDA|Vulkan|GPU|device)|CUDA driver|unsupported.*(?:gpu|architecture)|no kernel image|device lost/i.test(text)
export const gpuLoaderFailure = (code: number | null): boolean => code !== null
  && [0xc0000135, 0xc0000142, 0xc000007b, 0xc0000139, 0xc000001d].includes(code >>> 0)
export const gpuMemoryFailure = (text: string): boolean => /out of (?:device )?memory|VK_ERROR_OUT_OF_(?:DEVICE|HOST)_MEMORY|cudaMalloc.*failed/i.test(text)

const stopping = new WeakMap<ChildProcess, Promise<void>>()

/** Keep ownership until close; a decoder ignoring SIGTERM must not survive cancellation. */
export function stopLocalModelProcess(child: ChildProcess): Promise<void> {
  const existing = stopping.get(child)
  if (existing) return existing
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  const pending = new Promise<void>(resolve => {
    const timeout = setTimeout(() => { child.kill('SIGKILL') }, 2000)
    timeout.unref()
    child.once('close', () => { clearTimeout(timeout); resolve() })
    child.kill()
  })
  stopping.set(child, pending)
  return pending
}

export function localModelProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Apply one offline/loader policy to the translator, audio tools and archive decompressor.
  return Object.fromEntries(Object.entries(source).filter(([key]) => !/^(LLAMA_|HF_|HUGGING_FACE_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|DYLD_|LD_PRELOAD$|LD_LIBRARY_PATH$|LD_AUDIT$|GGML_|CUDA_VISIBLE_DEVICES$|CUDA_DEVICE_ORDER$)/i.test(key)))
}

export function runLocalModelProcess(executable: string, args: string[], options: {
  signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv; maxBytes?: number
  runtimeEnv?: NodeJS.ProcessEnv; diagnostic?: (text: string) => void
} = {}): Promise<string> {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...localModelProcessEnvironment(options.env), ...options.runtimeEnv } })
    const chunks: Buffer[] = []
    let bytes = 0, failure: Error | null = null, diagnostic = ''
    const terminate = (error: Error): void => {
      if (failure) return
      failure = error
      void stopLocalModelProcess(child)
    }
    const abort = (): void => terminate(new Error('任务已取消'))
    const timeout = setTimeout(() => terminate(new Error('本地模型任务超时')), options.timeoutMs ?? 180000)
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length
      if (bytes > (options.maxBytes ?? 4 * 1024 * 1024)) terminate(new Error('本地模型结果超限'))
      else chunks.push(data)
    })
    // Bounded volatile diagnostics; only derived GPU state reaches product snapshots/logs.
    child.stderr.on('data', (data: Buffer) => { diagnostic = (diagnostic + data.toString()).slice(-65536) })
    child.once('error', (error: NodeJS.ErrnoException) => { failure = new LocalModelProcessFailure(path.basename(executable), null, error.code === 'ENOENT') })
    child.once('close', code => {
      clearTimeout(timeout); options.signal?.removeEventListener('abort', abort)
      options.diagnostic?.(diagnostic)
      if (failure || code !== 0) reject(failure ?? new LocalModelProcessFailure(path.basename(executable), code, gpuDiagnosticFailure(diagnostic) || gpuLoaderFailure(code)))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
}
