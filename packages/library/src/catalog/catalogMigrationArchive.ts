import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline, finished } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import type { RootMapping } from '@shared/protocol/migration'
import { MIGRATION_PACKAGE_MAX_BYTES } from '@shared/protocol/limits'
import { structuredError } from '@shared/protocol/errors'

export const MIGRATION_FORMAT_VERSION = 1

const BLOCK = 512
const TYPE_FILE = '0'
const TYPE_DIR = '5'

export interface MigrationManifest {
  formatVersion: number
  protocolVersion: number
  appVersion: string
  schemaVersion: number
  sourcePlatform: string
  sourceServerId: string | null
  sourceCatalogId: string
  migrationId: string
  previewDigest: string
  mappings: RootMapping[]
  autoCleanupDisabledLibraryIds: number[]
  dataCount: number
  dataDigest: string
  imageCount: number
  imageDigest: string
  mappingDigest: string
  createdAt: string
}

export interface PackedArchiveMember {
  name: string
  absPath: string
}

function octal(value: number, width: number): string {
  const body = Math.max(0, value).toString(8)
  return `${body.padStart(width - 1, '0')}\0`
}

function splitUstarName(name: string): { prefix: string; name: string } {
  if (Buffer.byteLength(name) <= 100) return { prefix: '', name }
  for (let index = name.lastIndexOf('/'); index > 0; index = name.lastIndexOf('/', index - 1)) {
    if (Buffer.byteLength(name.slice(0, index)) <= 155 && Buffer.byteLength(name.slice(index + 1)) <= 100) {
      return { prefix: name.slice(0, index), name: name.slice(index + 1) }
    }
  }
  throw structuredError('LIMIT_EXCEEDED', '归档条目路径过长')
}

function checksumHeader(header: Buffer): number {
  let sum = 0
  for (let i = 0; i < BLOCK; i += 1) sum += header[i]
  return sum
}

function writeHeader(name: string, size: number, typeflag: string, mtime: number): Buffer {
  const header = Buffer.alloc(BLOCK, 0)
  const split = splitUstarName(name.replace(/\\/g, '/'))
  header.write(split.name, 0, 100, 'utf8')
  header.write(octal(typeflag === TYPE_DIR ? 0o755 : 0o644, 8), 100, 8, 'latin1')
  header.write(octal(0, 8), 108, 8, 'latin1')
  header.write(octal(0, 8), 116, 8, 'latin1')
  if (size < 8 * 1024 ** 3) header.write(octal(size, 12), 124, 12, 'latin1')
  else { header[124] = 0x80; header.writeBigUInt64BE(BigInt(size), 128) }
  header.write(octal(Math.floor(mtime), 12), 136, 12, 'latin1')
  header.write('        ', 148, 8, 'latin1')
  header.write(typeflag, 156, 1, 'latin1')
  header.write('ustar\0', 257, 6, 'latin1')
  header.write('00', 263, 2, 'latin1')
  header.write(split.prefix, 345, 155, 'utf8')
  const sum = checksumHeader(header)
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1')
  return header
}

function padToBlock(size: number): number {
  const rem = size % BLOCK
  return rem === 0 ? 0 : BLOCK - rem
}

function assertSafeArchiveName(name: string, seen: Set<string>): void {
  const normalized = name.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || normalized.includes(':')) {
    throw structuredError('INVALID_INPUT', '迁移归档包含非法路径')
  }
  const parts = normalized.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw structuredError('INVALID_INPUT', '迁移归档包含非法路径')
  }
  if (seen.has(normalized)) {
    throw structuredError('INVALID_INPUT', '迁移归档包含重复条目')
  }
  seen.add(normalized)
}

export function sha256File(filePath: string): string {
  const hash = createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(64 * 1024)
    let read = 0
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read))
    }
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function pipeWithoutEnd(sourcePath: string, dest: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const source = fs.createReadStream(sourcePath)
    const onError = (error: Error): void => {
      source.destroy()
      dest.removeListener('error', onError)
      reject(error)
    }
    source.on('error', onError)
    dest.on('error', onError)
    source.on('end', () => { dest.removeListener('error', onError); resolve() })
    source.pipe(dest, { end: false })
  })
}

export async function packMigrationArchive(
  members: PackedArchiveMember[],
  destFile: string,
  options: { maxBytes?: number; onProgress?: (completed: number, total: number) => void } = {}
): Promise<{ bytes: number }> {
  const maxBytes = options.maxBytes ?? MIGRATION_PACKAGE_MAX_BYTES
  fs.mkdirSync(path.dirname(destFile), { recursive: true })
  const seen = new Set<string>()
  let written = 0
  const gzip = createGzip()
  const output = fs.createWriteStream(destFile)
  gzip.on('error', () => undefined)
  output.on('error', () => undefined)
  let limitHit = false
  const counting = new Transform({
    transform(chunk, _enc, callback) {
      written += chunk.length
      if (written > maxBytes) {
        limitHit = true
        callback(new Error('LIMIT_EXCEEDED:migration-package'))
        return
      }
      callback(null, chunk)
    }
  })
  counting.on('error', () => undefined)
  const piping = pipeline(gzip, counting, output)
  void piping.catch(() => undefined)
  try {
    let completed = 0
    for (const member of members) {
      if (limitHit) break
      const name = member.name.replace(/\\/g, '/')
      assertSafeArchiveName(name, seen)
      const stat = fs.lstatSync(member.absPath)
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw structuredError('INVALID_INPUT', '迁移归档不能包含符号链接或特殊文件')
      }
      if (stat.isDirectory()) {
        gzip.write(writeHeader(`${name.replace(/\/+$/, '')}/`, 0, TYPE_DIR, stat.mtimeMs / 1000))
        continue
      }
      gzip.write(writeHeader(name, stat.size, TYPE_FILE, stat.mtimeMs / 1000))
      await pipeWithoutEnd(member.absPath, gzip)
      const pad = padToBlock(stat.size)
      if (pad) gzip.write(Buffer.alloc(pad, 0))
      options.onProgress?.(++completed, members.length)
    }
    if (!limitHit) {
      gzip.write(Buffer.alloc(BLOCK * 2, 0))
      gzip.end()
    } else {
      gzip.destroy()
    }
    await piping
  } catch (error) {
    gzip.destroy()
    output.destroy()
    await Promise.allSettled([
      piping,
      finished(gzip),
      finished(output)
    ])
    fs.rmSync(destFile, { force: true })
    if (limitHit || (error instanceof Error && error.message === 'LIMIT_EXCEEDED:migration-package')) {
      throw structuredError('LIMIT_EXCEEDED', '迁移包超过大小上限', { limit: maxBytes, actual: written })
    }
    throw error
  }
  return { bytes: written }
}

interface TarHeader {
  name: string
  size: number
  typeflag: string
}

function parseOctal(buf: Buffer): number {
  if (buf[0] & 0x80) {
    let value = BigInt(buf[0] & 0x7f)
    for (const byte of buf.subarray(1)) value = value * 256n + BigInt(byte)
    return Number(value)
  }
  const text = buf.toString('latin1').replace(/\0/g, '').trim()
  if (!text) return 0
  return Number.parseInt(text, 8)
}

function readHeader(block: Buffer): TarHeader | null {
  if (block.every((byte) => byte === 0)) return null
  const checksumStored = parseOctal(block.subarray(148, 156))
  const clone = Buffer.from(block)
  clone.write('        ', 148, 8, 'latin1')
  if (checksumHeader(clone) !== checksumStored) {
    throw structuredError('INVALID_INPUT', '迁移归档头校验失败')
  }
  const name = block.subarray(0, 100).toString('utf8').replace(/\0/g, '')
  const prefix = block.subarray(345, 500).toString('utf8').replace(/\0/g, '')
  const full = prefix ? `${prefix}/${name}` : name
  return {
    name: full.replace(/\/+$/, ''),
    size: parseOctal(block.subarray(124, 136)),
    typeflag: String.fromCharCode(block[156] || 48)
  }
}

export async function unpackMigrationArchive(
  archiveFile: string,
  destDir: string,
  options: { maxBytes?: number; availableBytes?: number } = {}
): Promise<{ files: string[]; bytes: number }> {
  const maxBytes = options.maxBytes ?? MIGRATION_PACKAGE_MAX_BYTES
  const archiveStat = fs.statSync(archiveFile)
  if (archiveStat.size > maxBytes) {
    throw structuredError('LIMIT_EXCEEDED', '迁移包超过大小上限', {
      limit: maxBytes,
      actual: archiveStat.size
    })
  }
  if (options.availableBytes != null && options.availableBytes < archiveStat.size * 2) {
    throw structuredError('LIMIT_EXCEEDED', '磁盘空间不足解包迁移数据')
  }
  fs.mkdirSync(destDir, { recursive: true })
  const seen = new Set<string>()
  const files: string[] = []
  let pending = Buffer.alloc(0)
  const openFile: { current: { abs: string; left: number; fd: number } | null } = { current: null }
  let unpacked = 0
  let inflated = 0
  const archiveOverhead = Math.min(16 * 1024 * 1024, Math.max(1024, Math.ceil(maxBytes / 16)))
  const inflatedLimit = maxBytes + archiveOverhead

  const handleHeader = (block: Buffer): void => {
    const parsed = readHeader(block)
    if (!parsed) return
    assertSafeArchiveName(parsed.name, seen)
    if (parsed.typeflag !== TYPE_FILE && parsed.typeflag !== TYPE_DIR && parsed.typeflag !== '\0') {
      throw structuredError('INVALID_INPUT', '迁移归档包含不支持的条目类型')
    }
    const abs = path.resolve(destDir, parsed.name)
    const rel = path.relative(destDir, abs)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw structuredError('INVALID_INPUT', '迁移归档包含非法路径')
    }
    if (parsed.typeflag === TYPE_DIR) {
      fs.mkdirSync(abs, { recursive: true })
      return
    }
    if (options.availableBytes != null && unpacked + parsed.size > options.availableBytes) throw structuredError('LIMIT_EXCEEDED', '磁盘空间不足解包数据')
    files.push(parsed.name)
    if (parsed.size === 0) {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, Buffer.alloc(0))
      openFile.current = null
      return
    }
    if (!Number.isSafeInteger(parsed.size) || parsed.size < 0 || parsed.size > maxBytes) throw structuredError('INVALID_INPUT', '归档文件大小无效')
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    openFile.current = { abs, left: parsed.size, fd: fs.openSync(abs, 'wx') }
  }

  const gunzip = createGunzip()
  const input = fs.createReadStream(archiveFile)
  input.on('error', error => gunzip.destroy(error))
  const unzipped = input.pipe(gunzip)
  try {
    for await (const chunk of unzipped) {
      inflated += (chunk as Buffer).byteLength
      if (inflated > inflatedLimit) {
        throw structuredError('LIMIT_EXCEEDED', '迁移包解压流超过大小上限', {
          limit: inflatedLimit,
          actual: inflated
        })
      }
      pending = Buffer.concat([pending, chunk as Buffer])
      while (pending.length >= BLOCK) {
        const block = pending.subarray(0, BLOCK)
        pending = pending.subarray(BLOCK)
        const current = openFile.current
        if (current && current.left > 0) {
          const take = Math.min(current.left, BLOCK)
          fs.writeSync(current.fd, block.subarray(0, take))
          unpacked += take
          current.left -= take
          if (unpacked > maxBytes) {
            throw structuredError('LIMIT_EXCEEDED', '迁移包解压后超过大小上限', {
              limit: maxBytes,
              actual: unpacked
            })
          }
          if (current.left === 0) {
            fs.closeSync(current.fd)
            openFile.current = null
          }
        } else {
          handleHeader(block)
        }
      }
    }
  } catch (error) {
    gunzip.destroy()
    input.destroy()
    if (openFile.current) fs.closeSync(openFile.current.fd)
    throw error
  }
  if (openFile.current) {
    fs.closeSync(openFile.current.fd)
    throw structuredError('INVALID_INPUT', '迁移归档不完整')
  }
  if (pending.length) throw structuredError('INVALID_INPUT', '归档尾部不完整')
  return { files, bytes: unpacked }
}

export function walkFiles(root: string): string[] {
  const files: string[] = []
  const visit = (current: string): void => {
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) {
      throw structuredError('INVALID_INPUT', '迁移目录不能包含符号链接')
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current).sort()) visit(path.join(current, entry))
      return
    }
    if (!stat.isFile()) throw structuredError('INVALID_INPUT', '迁移目录包含不支持的文件类型')
    files.push(current)
  }
  if (fs.existsSync(root)) visit(root)
  return files
}

export function posixRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/')
}
