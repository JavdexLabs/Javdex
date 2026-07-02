import fs from 'node:fs'
import path from 'node:path'
import { decryptBlob, encryptPlain, isEncryptedBlob } from './assetCrypto'
import { aliasStoreAbsAt, ASSET_PATH_ALIAS_FILENAME, resolveMediaAssetsRoot } from './assetStoragePaths'

function aliasStoreAbs(): string {
  return aliasStoreAbsAt(resolveMediaAssetsRoot())
}

function readAliasMap(): Record<string, string> {
  const abs = aliasStoreAbs()
  if (!fs.existsSync(abs)) return {}
  try {
    const raw = fs.readFileSync(abs)
    if (!isEncryptedBlob(raw)) return {}
    const { data } = decryptBlob(raw)
    const parsed = JSON.parse(data.toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key === 'string' && typeof value === 'string' && key && value) {
        out[key] = value
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeAliasMap(map: Record<string, string>): void {
  const abs = aliasStoreAbs()
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const json = JSON.stringify(map)
  const tmp = `${abs}.tmp-${process.pid}`
  fs.writeFileSync(tmp, encryptPlain(Buffer.from(json, 'utf8'), '.json'))
  fs.renameSync(tmp, abs)
}

export function getPathAlias(encRel: string): string | undefined {
  return readAliasMap()[encRel]
}

export function setPathAlias(encRel: string, plainRel: string): void {
  const map = readAliasMap()
  map[encRel] = plainRel
  writeAliasMap(map)
}

export function removePathAlias(encRel: string): void {
  const map = readAliasMap()
  if (!(encRel in map)) return
  delete map[encRel]
  if (Object.keys(map).length === 0) {
    clearPathAliasStore()
    return
  }
  writeAliasMap(map)
}

export function clearPathAliasStore(): void {
  const abs = aliasStoreAbs()
  if (fs.existsSync(abs)) fs.unlinkSync(abs)
}

export { ASSET_PATH_ALIAS_FILENAME }
