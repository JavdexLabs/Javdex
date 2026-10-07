import { spawn } from 'node:child_process'
import path from 'node:path'

export class SubtitleProcessFailure extends Error {
  constructor(readonly tool: string, readonly exitCode: number | null) { super('离线字幕运行库执行失败') }
}

export function subtitleProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Apply one offline/loader policy to the translator, audio tools and archive decompressor.
  return Object.fromEntries(Object.entries(source).filter(([key]) => !/^(LLAMA_|HF_|HUGGING_FACE_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|DYLD_|LD_PRELOAD$|LD_LIBRARY_PATH$|LD_AUDIT$)/i.test(key)))
}

export function runSubtitleProcess(executable: string, args: string[], options: {
  signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv; maxBytes?: number
} = {}): Promise<string> {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: subtitleProcessEnvironment(options.env) })
    const chunks: Buffer[] = []
    let bytes = 0, failure: Error | null = null
    const abort = (): void => { failure = new Error('任务已取消'); child.kill() }
    const timeout = setTimeout(() => { failure = new Error('离线字幕任务超时'); child.kill() }, options.timeoutMs ?? 180000)
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length
      if (bytes > (options.maxBytes ?? 4 * 1024 * 1024)) { failure = new Error('离线字幕结果超限'); child.kill() }
      else chunks.push(data)
    })
    // Do not copy decoder stderr into application logs: it can include grants and file paths.
    child.stderr.resume()
    child.once('error', () => { failure = new Error('无法启动离线字幕运行库') })
    child.once('close', code => {
      clearTimeout(timeout); options.signal?.removeEventListener('abort', abort)
      if (failure || code !== 0) reject(failure ?? new SubtitleProcessFailure(path.basename(executable), code))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
}
