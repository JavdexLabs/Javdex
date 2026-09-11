import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { decryptBlob, encryptPlain, isEncryptedBlob } from './assetCrypto'
import { aliasStoreAbsAt, ASSET_PATH_ALIAS_FILENAME, resolveMediaAssetsRoot } from './assetStoragePaths'

const MAGIC = Buffer.from('JAVDEX-ALIASES-2\n')
type AliasRecord = { op: 'set'; key: string; value: string } | { op: 'delete'; key: string }
  | { op: 'snapshot'; aliases: Record<string, string> }
interface AliasState {
  file: string
  signature: string | null
  aliases: Map<string, string>
  legacy: boolean
  validBytes: number
  snapshotBytes: number
  tailBytes: number
  records: number
}
let cached: AliasState | undefined

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  const fd = fs.openSync(directory, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

function signature(stat: fs.Stats): string {
  return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])
}

function fileSignature(file: string): string | null {
  try { return signature(fs.statSync(file)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

function readMap(value: unknown): Map<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid alias snapshot')
  const result = new Map<string, string>()
  for (const [key, alias] of Object.entries(value)) {
    if (!key || typeof alias !== 'string' || !alias) throw new Error('Invalid asset alias')
    result.set(key, alias)
  }
  return result
}

function load(): AliasState {
  const file = aliasStoreAbsAt(resolveMediaAssetsRoot())
  const stamp = fileSignature(file)
  if (cached?.file === file && cached.signature === stamp) return cached
  const state: AliasState = { file, signature: stamp, aliases: new Map(), legacy: false,
    validBytes: 0, snapshotBytes: 0, tailBytes: 0, records: 0 }
  if (stamp !== null) {
    const raw = fs.readFileSync(file)
    if (isEncryptedBlob(raw)) {
      state.aliases = readMap(JSON.parse(decryptBlob(raw).data.toString('utf8')))
      state.legacy = true
      state.validBytes = raw.length
    } else {
      if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Invalid asset alias journal')
      let offset = MAGIC.length
      while (offset < raw.length) {
        if (raw.length - offset < 8) {
          if (offset === MAGIC.length) throw new Error('Incomplete alias snapshot')
          break
        }
        const length = raw.readUInt32LE(offset)
        if (!length || raw.readUInt32LE(offset + 4) !== (length ^ 0xffffffff) >>> 0) throw new Error('Invalid alias frame header')
        if (length > raw.length - offset - 8) {
          if (offset === MAGIC.length) throw new Error('Incomplete alias snapshot')
          break
        }
        const record = JSON.parse(decryptBlob(raw.subarray(offset + 8, offset + 8 + length)).data.toString('utf8')) as AliasRecord
        if (record.op === 'snapshot') {
          if (offset !== MAGIC.length) throw new Error('Unexpected alias snapshot')
          state.aliases = readMap(record.aliases)
          state.snapshotBytes = length + 8
          state.tailBytes = 0
          state.records = 0
        } else {
          if (offset === MAGIC.length) throw new Error('Missing alias snapshot')
          if (!record.key || typeof record.key !== 'string') throw new Error('Invalid alias record key')
          if (record.op === 'set' && typeof record.value === 'string' && record.value) state.aliases.set(record.key, record.value)
          else if (record.op === 'delete') state.aliases.delete(record.key)
          else throw new Error('Invalid alias operation')
          state.tailBytes += length + 8
          state.records++
        }
        offset += length + 8
      }
      if (offset === MAGIC.length) throw new Error('Missing alias snapshot')
      state.validBytes = offset
    }
    if (fileSignature(file) !== stamp) throw new Error('Alias file changed while reading')
  }
  cached = state
  return state
}

function frame(record: AliasRecord): Buffer {
  const encrypted = encryptPlain(Buffer.from(JSON.stringify(record)), '.json')
  const header = Buffer.alloc(8)
  header.writeUInt32LE(encrypted.length)
  header.writeUInt32LE((encrypted.length ^ 0xffffffff) >>> 0, 4)
  return Buffer.concat([header, encrypted])
}

function writeSnapshot(state: AliasState, aliases: Map<string, string>): void {
  const body = frame({ op: 'snapshot', aliases: Object.fromEntries(aliases) })
  fs.mkdirSync(path.dirname(state.file), { recursive: true })
  const temporary = `${state.file}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = fs.openSync(temporary, 'wx')
    fs.writeFileSync(fd, Buffer.concat([MAGIC, body]))
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temporary, state.file)
    syncDirectory(path.dirname(state.file))
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
  cached = { ...state, aliases, signature: fileSignature(state.file), legacy: false,
    validBytes: MAGIC.length + body.length, snapshotBytes: body.length, tailBytes: 0, records: 0 }
}

function update(record: Exclude<AliasRecord, { op: 'snapshot' }>): void {
  const state = load()
  try {
    if (state.legacy || state.signature === null) {
      const aliases = new Map(state.aliases)
      if (record.op === 'set') aliases.set(record.key, record.value)
      else aliases.delete(record.key)
      writeSnapshot(state, aliases)
      return
    }
    const body = frame(record)
    const fd = fs.openSync(state.file, 'r+')
    try {
      if (signature(fs.fstatSync(fd)) !== state.signature) throw new Error('Alias file changed before append')
      fs.ftruncateSync(fd, state.validBytes)
      let written = 0
      while (written < body.length) {
        const count = fs.writeSync(fd, body, written, body.length - written, state.validBytes + written)
        if (!count) throw new Error('Incomplete alias write')
        written += count
      }
      fs.fsyncSync(fd)
      if (signature(fs.fstatSync(fd)) !== fileSignature(state.file)) throw new Error('Alias file replaced during append')
    } finally { fs.closeSync(fd) }
    if (record.op === 'set') state.aliases.set(record.key, record.value)
    else state.aliases.delete(record.key)
    state.validBytes += body.length
    state.tailBytes += body.length
    state.records++
    state.signature = fileSignature(state.file)
    // Both thresholds prevent repeated whole-map rewrites as the live map grows.
    if (state.records >= 4096 && state.tailBytes >= state.snapshotBytes) {
      try { writeSnapshot(state, state.aliases) }
      catch (error) { cached = undefined; console.error('Alias journal compaction failed:', error) }
    }
  } catch (error) { cached = undefined; throw error }
}

export function getPathAlias(encRel: string): string | undefined { return load().aliases.get(encRel) }

export function setPathAlias(encRel: string, plainRel: string): void {
  if (!encRel || !plainRel) throw new Error('Asset aliases must not be empty')
  if (load().aliases.get(encRel) !== plainRel) update({ op: 'set', key: encRel, value: plainRel })
}

export function removePathAlias(encRel: string): void {
  const state = load()
  if (!state.aliases.has(encRel)) return
  if (state.aliases.size === 1) clearPathAliasStore()
  else update({ op: 'delete', key: encRel })
}

export function clearPathAliasStore(): void {
  const file = aliasStoreAbsAt(resolveMediaAssetsRoot())
  try {
    if (fs.existsSync(file)) { fs.unlinkSync(file); syncDirectory(path.dirname(file)) }
  } finally { cached = undefined }
}

export function resetPathAliasCacheForTests(): void { cached = undefined }
export { ASSET_PATH_ALIAS_FILENAME }
