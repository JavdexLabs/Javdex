import fs from 'node:fs'
import path from 'node:path'

const MIN_FREE_BYTES = 64 * 1024 * 1024
const REMOTE_FS_TYPES = new Set([
  0x6969, // NFS
  0xff534d42, // CIFS
  0x517b, // SMB
  0x65735546, // FUSE
  0x1021997 // 9P
])

export class ServerFilesystemError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServerFilesystemError'
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function ensureLocalDataDir(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK)
  const stats = fs.statSync(dataDir)
  if (!stats.isDirectory()) throw new ServerFilesystemError('数据目录必须是目录')
  const space = fs.statfsSync(dataDir)
  if (REMOTE_FS_TYPES.has(Number(space.type))) {
    throw new ServerFilesystemError('SQLite 数据目录必须位于本地文件系统，不能使用网络盘或 FUSE')
  }
  if (space.bavail * space.bsize < MIN_FREE_BYTES) {
    throw new ServerFilesystemError('数据目录可用空间不足 64MiB')
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    // Writable is already proven; ownership mismatch is allowed for volume mounts.
  }
}

export function ensureMediaMounts(
  dataDir: string,
  imagesDir: string,
  mediaMounts: Record<string, string>
): string[] {
  fs.mkdirSync(imagesDir, { recursive: true })
  const dataReal = fs.realpathSync(dataDir)
  const imageReal = fs.realpathSync(imagesDir)
  const resolved: string[] = []
  for (const [name, mount] of Object.entries(mediaMounts)) {
    if (!fs.existsSync(mount)) {
      throw new ServerFilesystemError(`媒体挂载不存在: ${name}`)
    }
    const real = fs.realpathSync(mount)
    const stat = fs.statSync(real)
    if (!stat.isDirectory()) {
      throw new ServerFilesystemError(`媒体挂载必须是目录: ${name}`)
    }
    if (real === dataReal || real === imageReal) {
      throw new ServerFilesystemError('媒体挂载必须与数据卷/图片目录分离')
    }
    if (real.startsWith(`${dataReal}${path.sep}`) || dataReal.startsWith(`${real}${path.sep}`)) {
      throw new ServerFilesystemError('媒体挂载不能与数据目录互相包含')
    }
    resolved.push(real)
  }
  return resolved
}

export function acquireDataDirLock(dataDir: string): { release(): void } {
  const lockPath = path.join(dataDir, 'instance.lock')
  const pid = process.pid
  try {
    fs.writeFileSync(lockPath, `${pid}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = Number(fs.readFileSync(lockPath, 'utf8').trim())
    if (Number.isInteger(existing) && existing > 0 && isAlive(existing)) {
      throw new ServerFilesystemError(`数据目录已被进程 ${existing} 占用`)
    }
    fs.writeFileSync(lockPath, `${pid}\n`, { mode: 0o600 })
  }
  return {
    release(): void {
      try {
        if (fs.readFileSync(lockPath, 'utf8').trim() === String(pid)) fs.unlinkSync(lockPath)
      } catch {
        // Lock is advisory; process exit still releases the SQLite writer.
      }
    }
  }
}

export function pathIsInside(file: string, root: string): boolean {
  const resolvedFile = path.resolve(file)
  const resolvedRoot = path.resolve(root)
  return resolvedFile === resolvedRoot || resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)
}
