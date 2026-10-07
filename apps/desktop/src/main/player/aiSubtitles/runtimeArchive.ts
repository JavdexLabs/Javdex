import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Parser } from 'tar'
import { subtitleProcessEnvironment } from './processRunner'

export function safeRuntimePath(name: string): boolean {
  return name.length > 0 && name.length < 1024 && !/[\\:\x00-\x1f]/.test(name)
    && !path.posix.isAbsolute(name) && name.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}
const retained = (name: string): boolean => /^(whisper-cli|llama-server|ffmpeg|ffprobe)$|\.(?:so(?:\.[\d.]+)?|dylib|metal|metallib)$|^(LICENSE|COPYING|NOTICE|README|SOURCE)/i.test(path.posix.basename(name))

/** Never create archive symlinks: resolve bounded in-archive aliases to regular copies.
 * Keeping bin/lib directories preserves upstream $ORIGIN/../lib loader paths. */
export async function extractPosixRuntime(archive: string, destination: string, prefix: string, signal: AbortSignal): Promise<void> {
  const parser = new Parser({ strict: true, maxMetaEntrySize: 64 * 1024 })
  const selected = new Map<string, { name: string; link?: string }>()
  const writes: Promise<void>[] = []
  let entries = 0, total = 0
  const relative = (name: string): string => {
    const normalized = name.replace(/^\.\//, '').replace(/\/$/, '')
    if (!safeRuntimePath(normalized) || !(normalized === prefix || normalized.startsWith(`${prefix}/`))) throw new Error('运行库压缩包路径不安全')
    return normalized.slice(prefix.length + 1)
  }
  parser.on('entry', entry => {
    try {
      signal.throwIfAborted()
      if (++entries > 5000 || !Number.isSafeInteger(entry.size) || entry.size < 0 || (total += entry.size) > 1024 ** 3) throw new Error('运行库压缩包超过安全限制')
      const name = relative(entry.path)
      if (entry.type === 'Directory') { entry.resume(); return }
      if (!['File', 'OldFile', 'SymbolicLink', 'Link'].includes(entry.type)) throw new Error('运行库包含不支持的文件类型')
      if (!retained(name)) { entry.resume(); return }
      if (!safeRuntimePath(name) || selected.has(name)) throw new Error('运行库包含重复或不安全的文件')
      if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
        const link = entry.linkpath ?? ''
        if (!link || /[\\:\x00-\x1f]/.test(link) || path.posix.isAbsolute(link)) throw new Error('运行库链接不安全')
        const target = entry.type === 'Link' ? relative(link) : path.posix.normalize(path.posix.join(path.posix.dirname(name), link))
        if (!safeRuntimePath(target)) throw new Error('运行库链接越界')
        selected.set(name, { name, link: target }); entry.resume(); return
      }
      selected.set(name, { name })
      const filename = path.join(destination, name)
      const write = (async () => {
        await fs.mkdir(path.dirname(filename), { recursive: true })
        await pipeline(entry, createWriteStream(filename, { flags: 'wx', mode: 0o644 }), { signal })
        if (/^(whisper-cli|llama-server|ffmpeg|ffprobe)$/.test(path.posix.basename(name))) await fs.chmod(filename, 0o755)
      })()
      writes.push(write)
      void write.catch(error => parser.abort(error))
    } catch (error) { entry.resume(); parser.abort(error as Error) }
  })
  const decompressor = /\.xz(?:\.part)?$/.test(archive) ? spawn('xz', ['-dc', '--', archive], {
    stdio: ['ignore', 'pipe', 'pipe'], shell: false, signal, env: subtitleProcessEnvironment()
  }) : null
  // Drain stderr, but do not expose local paths or accept instructions from it.
  decompressor?.stderr.resume()
  const decompressed = decompressor ? new Promise<void>((resolve, reject) => {
    decompressor.once('error', reject)
    decompressor.once('exit', code => code === 0 ? resolve() : reject(new Error('运行库 xz 解压失败；Linux 需安装 xz-utils')))
  }) : Promise.resolve()
  void decompressed.catch(error => parser.abort(error))
  try {
    await pipeline(decompressor?.stdout ?? createReadStream(archive), parser, { signal })
    await Promise.all(writes)
    await decompressed
    for (const entry of selected.values()) {
      if (!entry.link) continue
      let target = entry, depth = 0
      while (target.link) {
        if (++depth > 32 || !selected.has(target.link)) throw new Error('运行库链接缺少目标或形成循环')
        target = selected.get(target.link)!
      }
      const filename = path.join(destination, entry.name)
      await fs.mkdir(path.dirname(filename), { recursive: true })
      await fs.copyFile(path.join(destination, target.name), filename, 1)
    }
  } finally {
    if (decompressor && decompressor.exitCode === null) decompressor.kill()
    await Promise.allSettled([...writes, decompressed])
  }
}
