import fs from 'node:fs'
import path from 'node:path'
import { resolveLibraryMediaAssetsPath, resolveLibraryUserDataPath } from '@library/runtime/host'

export const MEDIA_ASSETS_DIRNAME = 'media_assets'
export const ASSET_PATH_ALIAS_FILENAME = '.asset-path-aliases.enc'

export const ASSET_MEDIA_SUBDIRS = [
  'covers',
  'avatars',
  'actress_gallery',
  'samples',
  'playlist_covers'
] as const

export function defaultMediaAssetsRoot(): string {
  return path.join(resolveLibraryUserDataPath(), MEDIA_ASSETS_DIRNAME)
}

/** Active media assets root (custom path or default under userData). */
export function resolveMediaAssetsRoot(): string {
  const custom = resolveLibraryMediaAssetsPath()
  if (!custom) return defaultMediaAssetsRoot()
  return path.resolve(custom)
}

export function mediaAssetsPathForSettings(absPath: string): string {
  const resolved = path.resolve(absPath)
  if (resolved === path.resolve(defaultMediaAssetsRoot())) return ''
  return resolved
}

export function validateMediaAssetsPath(target: string): string {
  const trimmed = target.trim()
  if (!trimmed) throw new Error('存储路径不能为空')
  const resolved = path.resolve(trimmed)
  if (!path.isAbsolute(resolved)) throw new Error('请选择有效的绝对路径')
  try {
    fs.mkdirSync(resolved, { recursive: true })
  } catch {
    throw new Error('无法创建或访问目标文件夹')
  }
  return resolved
}

export function ensureMediaAssetDirsAt(root: string): void {
  for (const subdir of ASSET_MEDIA_SUBDIRS) {
    fs.mkdirSync(path.join(root, subdir), { recursive: true })
  }
}

export function aliasStoreAbsAt(root: string): string {
  return path.join(root, ASSET_PATH_ALIAS_FILENAME)
}
