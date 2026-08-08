import fs from 'node:fs'
import path from 'node:path'
import { invalidateAssetCache } from '../assetCache'
import { encryptPlain, decryptBlob, isEncryptedBlob } from '../assetCrypto'
import {
  clearPathAliasStore,
  getPathAlias,
  removePathAlias,
  setPathAlias
} from '../assetPathAliases'
import { buildOpaqueAssetBaseFromPlainRel } from '../assetPathNaming'
import {
  assetsRoot,
  resolveAssetPath,
  writeAtomic
} from './filesystem'
import type { ImageAssetSubdir, StoredAssetPathRewrite } from './types'

const MIGRATION_SUBDIRS: ImageAssetSubdir[] = [
  'covers',
  'avatars',
  'actress_gallery',
  'samples',
  'playlist_covers'
]

function opaqueEncRelForPlain(plainRel: string): string {
  const dir = plainRel.includes('/') ? plainRel.slice(0, plainRel.lastIndexOf('/') + 1) : ''
  const opaqueBase = buildOpaqueAssetBaseFromPlainRel(plainRel)
  return `${dir}${opaqueBase}.enc`
}

/** List posix relative paths of image files under the stable media subdirectories. */
export function listStoredImageAssetRels(): string[] {
  const root = assetsRoot()
  const out: string[] = []
  for (const kind of MIGRATION_SUBDIRS) {
    const dir = path.join(root, kind)
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name)
      if (!fs.statSync(abs).isFile()) continue
      out.push(path.relative(root, abs).split(path.sep).join('/'))
    }
  }
  return out
}

/**
 * Encrypt one stored plain asset in place. Returns a path rewrite when the DB
 * reference must change; null when only alias bookkeeping ran or nothing changed.
 */
export function encryptStoredAsset(rel: string): StoredAssetPathRewrite | null {
  const plainRel = rel
  const encRel = opaqueEncRelForPlain(plainRel)
  if (encRel === rel) {
    if (!getPathAlias(encRel)) setPathAlias(encRel, plainRel)
    return null
  }

  const abs = resolveAssetPath(plainRel)
  const encAbs = resolveAssetPath(encRel)
  setPathAlias(encRel, plainRel)

  const ext = path.extname(plainRel) || '.jpg'
  const plain = fs.readFileSync(abs)
  writeAtomic(encAbs, encryptPlain(plain, ext))
  fs.unlinkSync(abs)

  invalidateAssetCache(rel)
  invalidateAssetCache(encRel)
  return { fromRel: rel, toRel: encRel }
}

/**
 * Decrypt one stored encrypted asset in place. Returns a path rewrite when the
 * DB reference must change; null when skipped or the relative path is unchanged.
 */
export function decryptStoredAsset(rel: string): StoredAssetPathRewrite | null {
  const abs = resolveAssetPath(rel)
  const blob = fs.readFileSync(abs)
  if (!isEncryptedBlob(blob)) return null
  const { data } = decryptBlob(blob)

  const plainRel = getPathAlias(rel)
  if (!plainRel) {
    throw new Error(`缺少加密路径别名，无法解密：${rel}`)
  }
  const plainAbs = resolveAssetPath(plainRel)

  fs.mkdirSync(path.dirname(plainAbs), { recursive: true })
  writeAtomic(plainAbs, data)
  fs.unlinkSync(abs)
  removePathAlias(rel)

  invalidateAssetCache(rel)
  invalidateAssetCache(plainRel)
  if (rel === plainRel) return null
  return { fromRel: rel, toRel: plainRel }
}

export function clearPathAliases(): void {
  clearPathAliasStore()
}
