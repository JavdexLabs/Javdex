import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileHash } from './releaseStore'

export const MANAGED_LOCK = '.javdex-managed.lock'
interface TreeOptions { excludeRootLock?: boolean }
export async function treeHash(root: string, options: TreeOptions = {}): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (directory: string): Promise<void> => {
    for (const name of (await fs.promises.readdir(directory)).sort()) {
      if (options.excludeRootLock && directory === root && name === MANAGED_LOCK) continue
      const file = path.join(directory, name)
      const stat = await fs.promises.lstat(file)
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('快照包含非法文件')
      hash.update(JSON.stringify([path.relative(root, file), stat.mode & 0o777, stat.uid, stat.gid, stat.isDirectory() ? 'directory' : await fileHash(file)]))
      if (stat.isDirectory()) await walk(file)
    }
  }
  await walk(root)
  return hash.digest('hex')
}
export async function treeBytes(root: string, options: TreeOptions = {}): Promise<number> {
  const stat = await fs.promises.lstat(root)
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('资料快照不允许链接或特殊文件')
  if (stat.isFile()) return stat.size
  let bytes = 0
  for (const name of await fs.promises.readdir(root)) if (!options.excludeRootLock || name !== MANAGED_LOCK) bytes += await treeBytes(path.join(root, name))
  return bytes
}
export async function copyTree(source: string, destination: string, options: TreeOptions = {}): Promise<void> {
  const stat = await fs.promises.lstat(source)
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('资料快照不允许链接或特殊文件')
  if (stat.isDirectory()) {
    await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 })
    for (const name of await fs.promises.readdir(source)) if (!options.excludeRootLock || name !== MANAGED_LOCK) await copyTree(path.join(source, name), path.join(destination, name))
  } else await fs.promises.copyFile(source, destination)
  const target = await fs.promises.stat(destination)
  if (target.uid !== stat.uid || target.gid !== stat.gid) await fs.promises.chown(destination, stat.uid, stat.gid)
  await fs.promises.chmod(destination, stat.mode & 0o777)
  await fs.promises.utimes(destination, stat.atime, stat.mtime)
  const fd = fs.openSync(destination, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
export async function restoreTree(source: string, destination: string, options: TreeOptions = {}): Promise<void> {
  // Validate both complete trees before removing anything. Keep the locked inode.
  await treeBytes(source, options); await treeBytes(destination, options)
  for (const name of await fs.promises.readdir(destination)) if (!options.excludeRootLock || name !== MANAGED_LOCK) await fs.promises.rm(path.join(destination, name), { recursive: true, force: true })
  await copyTree(source, destination, options)
}
