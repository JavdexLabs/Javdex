import fs from 'node:fs'
import path from 'node:path'
import type { AssetCryptoProgress } from '@shared/types'
import { invalidateAssetCache } from './assetCache'
import {
  aliasStoreAbsAt,
  ASSET_PATH_ALIAS_FILENAME,
  ensureMediaAssetDirsAt,
  mediaAssetsPathForSettings
} from './assetStoragePaths'

type ProgressFn = (p: AssetCryptoProgress) => void

function toPosixRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/')
}

function isTempAssetFile(name: string): boolean {
  return /\.tmp-\d+$/i.test(name)
}

function listAssetFiles(root: string): Array<{ rel: string; abs: string }> {
  if (!fs.existsSync(root)) return []
  const out: Array<{ rel: string; abs: string }> = []

  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      if (isTempAssetFile(name)) continue
      const abs = path.join(dir, name)
      const stat = fs.statSync(abs)
      if (stat.isDirectory()) {
        walk(abs)
        continue
      }
      if (!stat.isFile()) continue
      out.push({ rel: toPosixRel(root, abs), abs })
    }
  }

  walk(root)
  return out
}

function assertTargetRootReadyForMigration(root: string): void {
  if (!fs.existsSync(root)) return

  const existingFiles = listAssetFiles(root)
  if (existingFiles.length > 0) {
    throw new Error('目标文件夹已包含媒体资源文件，请选择其他空目录')
  }

  // A prior default layout may leave empty subfolders behind; clear them before migrate-in.
  removeTreeIfEmpty(root)
}

function copyFileAtomic(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.tmp-${process.pid}`
  fs.copyFileSync(src, tmp)
  fs.renameSync(tmp, dest)
}

function removeTreeIfEmpty(root: string): void {
  if (!fs.existsSync(root)) return

  const removeDir = (dir: string): boolean => {
    const entries = fs.readdirSync(dir).filter((name) => !isTempAssetFile(name))
    let empty = true
    for (const name of entries) {
      const abs = path.join(dir, name)
      if (fs.statSync(abs).isDirectory()) {
        if (!removeDir(abs)) empty = false
      } else {
        empty = false
      }
    }
    if (empty && dir !== root) {
      fs.rmdirSync(dir)
      return true
    }
    return false
  }

  removeDir(root)
  if (fs.existsSync(root) && fs.readdirSync(root).length === 0) {
    fs.rmdirSync(root)
  }
}

/**
 * Move all media asset files (plain, .enc, alias store) to a new root.
 * DB paths stay relative; only the on-disk root changes.
 */
export async function migrateMediaAssetsLocation(
  oldRoot: string,
  newRoot: string,
  onProgress: ProgressFn
): Promise<string> {
  const from = path.resolve(oldRoot)
  const to = path.resolve(newRoot)
  if (from === to) return mediaAssetsPathForSettings(to)

  assertTargetRootReadyForMigration(to)
  ensureMediaAssetDirsAt(to)

  const files = listAssetFiles(from)
  onProgress({
    phase: 'relocate',
    current: 0,
    total: Math.max(files.length, 1),
    currentFile: '',
    status: 'running'
  })

  for (let i = 0; i < files.length; i++) {
    const { rel, abs } = files[i]
    const dest = path.join(to, ...rel.split('/'))
    onProgress({
      phase: 'relocate',
      current: i + 1,
      total: files.length,
      currentFile: rel,
      status: 'running'
    })
    copyFileAtomic(abs, dest)
    if (i % 20 === 0) {
      await new Promise((r) => setImmediate(r))
    }
  }

  for (const { abs } of files) {
    fs.unlinkSync(abs)
  }
  removeTreeIfEmpty(from)
  invalidateAssetCache()

  onProgress({
    phase: 'relocate',
    current: files.length,
    total: files.length,
    currentFile: '',
    status: 'done'
  })

  return mediaAssetsPathForSettings(to)
}
