import fs from 'node:fs'
import path from 'node:path'
import { normalizeLocalPathIdentity } from './localPathIdentity'

export interface ResolvedMediaLibraryRootPath {
  path: string
  normalizedPath: string
  realPath: string | null
  normalizedRealPath: string | null
  deviceId: string | null
  inode: string | null
}

function isUnavailablePathError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false
  return ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EIO', 'ENXIO', 'ESTALE'].includes(
    String((error as NodeJS.ErrnoException).code)
  )
}

/** Main-process helper. Captures lexical identity even when a root is offline. */
export function resolveMediaLibraryRootIdentity(
  inputPath: string
): ResolvedMediaLibraryRootPath {
  if (typeof inputPath !== 'string') throw new Error('根目录路径必须是字符串。')
  const trimmed = inputPath.trim()
  if (!trimmed) throw new Error('根目录路径不能为空。')
  if (trimmed.includes('\0')) throw new Error('根目录路径包含无效字符。')
  if (!path.isAbsolute(trimmed)) throw new Error('根目录路径必须是绝对路径。')

  const resolvedPath = path.normalize(path.resolve(trimmed))
  const normalizedPath = normalizeLocalPathIdentity(resolvedPath)
  try {
    const realPath = path.normalize(fs.realpathSync.native(resolvedPath))
    const stat = fs.statSync(realPath, { bigint: true })
    if (!stat.isDirectory()) throw new Error('媒体库根路径必须指向目录。')
    return {
      path: resolvedPath,
      normalizedPath,
      realPath,
      normalizedRealPath: normalizeLocalPathIdentity(realPath),
      deviceId: stat.dev.toString(),
      inode: stat.ino.toString()
    }
  } catch (error) {
    if (!isUnavailablePathError(error)) throw error
    return {
      path: resolvedPath,
      normalizedPath,
      realPath: null,
      normalizedRealPath: null,
      deviceId: null,
      inode: null
    }
  }
}

function pathContains(parentPath: string, childPath: string): boolean {
  if (parentPath === childPath) return true
  const relative = path.relative(parentPath, childPath)
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function pathsOverlap(firstPath: string, secondPath: string): boolean {
  return pathContains(firstPath, secondPath) || pathContains(secondPath, firstPath)
}

export function mediaLibraryRootIdentitiesOverlap(
  first: ResolvedMediaLibraryRootPath,
  second: ResolvedMediaLibraryRootPath
): boolean {
  if (pathsOverlap(first.normalizedPath, second.normalizedPath)) return true
  if (
    first.normalizedRealPath &&
    second.normalizedRealPath &&
    pathsOverlap(first.normalizedRealPath, second.normalizedRealPath)
  ) {
    return true
  }
  return Boolean(
    first.deviceId &&
      first.inode &&
      second.deviceId &&
      second.inode &&
      first.deviceId === second.deviceId &&
      first.inode === second.inode
  )
}
