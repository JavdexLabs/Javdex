import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { readTestUserDataPath } from '@shared/appIdentity'
import { getSettings } from '../settings/settingsStore'

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
  const userData = readTestUserDataPath() ?? (typeof app?.getPath === 'function' ? app.getPath('userData') : '')
  if (!userData) throw new Error('无法解析应用数据目录')
  return path.join(userData, MEDIA_ASSETS_DIRNAME)
}

/** Active media assets root (custom path or default under userData). */
export function resolveMediaAssetsRoot(): string {
  const custom = getSettings().mediaAssetsPath?.trim()
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
