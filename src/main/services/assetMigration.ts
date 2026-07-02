import fs from 'node:fs'
import path from 'node:path'
import {
  assetsRoot,
  coversDir,
  avatarsDir,
  actressGalleryDir,
  samplesDir,
  playlistCoversDir
} from './assetService'
import { invalidateAssetCache } from './assetCache'
import type { AssetCryptoProgress } from '@shared/types'
import { encryptPlain, decryptBlob, isEncryptedBlob } from './assetCrypto'
import { remapAssetPath } from '../db/videoRepo'
import { buildOpaqueAssetBaseFromPlainRel, isOpaqueEncFilename } from './assetPathNaming'
import {
  clearPathAliasStore,
  getPathAlias,
  removePathAlias,
  setPathAlias
} from './assetPathAliases'

type ProgressFn = (p: AssetCryptoProgress) => void

function writeAtomic(abs: string, data: Buffer): void {
  const tmp = `${abs}.tmp-${process.pid}`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, abs)
}

function toPosixRel(abs: string): string {
  return path.relative(assetsRoot(), abs).split(path.sep).join('/')
}

function listAssetAbsPaths(): string[] {
  const out: string[] = []
  for (const dir of [
    coversDir(),
    avatarsDir(),
    actressGalleryDir(),
    samplesDir(),
    playlistCoversDir()
  ]) {
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name)
      if (fs.statSync(abs).isFile()) out.push(abs)
    }
  }
  return out
}

function filesToMigrate(enable: boolean, files: string[]): string[] {
  if (enable) {
    return files.filter((abs) => !toPosixRel(abs).toLowerCase().endsWith('.enc'))
  }
  return files.filter((f) => f.toLowerCase().endsWith('.enc'))
}

function resolvePlainAbs(plainRel: string): string {
  return path.join(assetsRoot(), ...plainRel.split('/'))
}

function opaqueEncRelForPlain(plainRel: string): string {
  const dir = plainRel.includes('/') ? plainRel.slice(0, plainRel.lastIndexOf('/') + 1) : ''
  const opaqueBase = buildOpaqueAssetBaseFromPlainRel(plainRel)
  return `${dir}${opaqueBase}.enc`
}

function migrateEncryptFile(abs: string, rel: string): void {
  const plainRel = rel
  const encRel = opaqueEncRelForPlain(plainRel)
  if (encRel === rel) {
    if (!getPathAlias(encRel)) setPathAlias(encRel, plainRel)
    return
  }

  const encAbs = resolvePlainAbs(encRel)
  setPathAlias(encRel, plainRel)

  const ext = path.extname(plainRel) || '.jpg'
  const plain = fs.readFileSync(abs)
  writeAtomic(encAbs, encryptPlain(plain, ext))
  fs.unlinkSync(abs)

  remapAssetPath(rel, encRel)
  invalidateAssetCache(rel)
  invalidateAssetCache(encRel)
}

function migrateDecryptFile(abs: string, rel: string): void {
  const blob = fs.readFileSync(abs)
  if (!isEncryptedBlob(blob)) return
  const { data } = decryptBlob(blob)

  const plainRel = getPathAlias(rel)
  if (!plainRel) {
    throw new Error(`缺少加密路径别名，无法解密：${rel}`)
  }
  const plainAbs = resolvePlainAbs(plainRel)

  fs.mkdirSync(path.dirname(plainAbs), { recursive: true })
  writeAtomic(plainAbs, data)
  fs.unlinkSync(abs)
  removePathAlias(rel)

  if (rel !== plainRel) remapAssetPath(rel, plainRel)
  invalidateAssetCache(rel)
  invalidateAssetCache(plainRel)
}

/** Batch encrypt or decrypt all assets under media_assets. Updates DB paths. */
export async function migrateAssetStorage(enable: boolean, onProgress: ProgressFn): Promise<void> {
  const files = listAssetAbsPaths()
  const targets = filesToMigrate(enable, files)
  const phase = enable ? 'encrypt' : 'decrypt'

  onProgress({
    phase,
    current: 0,
    total: targets.length,
    currentFile: '',
    status: 'running'
  })

  for (let i = 0; i < targets.length; i++) {
    const abs = targets[i]
    const rel = toPosixRel(abs)
    onProgress({
      phase,
      current: i + 1,
      total: targets.length,
      currentFile: rel,
      status: 'running'
    })

    try {
      if (enable) {
        migrateEncryptFile(abs, rel)
      } else {
        migrateDecryptFile(abs, rel)
      }
    } catch (err) {
      onProgress({
        phase,
        current: i + 1,
        total: targets.length,
        currentFile: rel,
        status: 'error',
        error: (err as Error).message
      })
      throw err
    }

    if (i % 20 === 0) {
      await new Promise((r) => setImmediate(r))
    }
  }

  if (!enable) clearPathAliasStore()

  onProgress({
    phase,
    current: targets.length,
    total: targets.length,
    currentFile: '',
    status: 'done'
  })
}
