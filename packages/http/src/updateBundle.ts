// Single-file transport only. Trust and install compatibility remain owned by
// the updater's signed manifest verifier; no key is taken from this container.
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import type { SignedServerUpdate } from '@shared/serverUpdateTypes'

const magic = Buffer.from('JVDXUPD1', 'ascii')
export const UPDATE_BUNDLE_HEADER_BYTES = 12
export const UPDATE_BUNDLE_MAX_MANIFEST = 65536

export function updateBundlePrefix(signed: SignedServerUpdate): Buffer {
  const json = Buffer.from(JSON.stringify(signed), 'utf8')
  if (!json.length || json.length > UPDATE_BUNDLE_MAX_MANIFEST) throw new Error('更新清单超过允许大小')
  const header = Buffer.alloc(UPDATE_BUNDLE_HEADER_BYTES)
  magic.copy(header); header.writeUInt32BE(json.length, 8)
  return Buffer.concat([header, json])
}
function manifestLength(header: Buffer): number {
  if (header.length !== UPDATE_BUNDLE_HEADER_BYTES || !header.subarray(0, 8).equals(magic)) throw new Error('不是受支持的 .javdex-update 文件')
  const length = header.readUInt32BE(8)
  if (!length || length > UPDATE_BUNDLE_MAX_MANIFEST) throw new Error('更新清单超过允许大小')
  return length
}
function readExactly(fd: number, size: number, offset: number): Buffer {
  const bytes = Buffer.alloc(size)
  let count = 0
  while (count < size) {
    const read = fs.readSync(fd, bytes, count, size - count, offset + count)
    if (!read) throw new Error('更新包不完整')
    count += read
  }
  return bytes
}
export function readUpdateBundle(fd: number): { signed: unknown; archiveOffset: number; archiveBytes: number } {
  const size = fs.fstatSync(fd)
  if (!size.isFile()) throw new Error('更新包必须是普通文件')
  const length = manifestLength(readExactly(fd, UPDATE_BUNDLE_HEADER_BYTES, 0))
  const archiveOffset = UPDATE_BUNDLE_HEADER_BYTES + length
  const archiveBytes = size.size - archiveOffset
  if (archiveBytes <= 0 || archiveBytes > 4 * 1024 ** 3) throw new Error('更新包大小无效或不完整')
  return { signed: JSON.parse(readExactly(fd, length, UPDATE_BUNDLE_HEADER_BYTES).toString('utf8')), archiveOffset, archiveBytes }
}

export async function verifyBundleArchive(fd: number, offset: number, bytes: number, expectedHash: string): Promise<void> {
  const hash = createHash('sha256')
  // One descriptor is retained for verification and upload (no path reopen).
  const stream = fs.createReadStream('', { fd, autoClose: false, start: offset, end: offset + bytes - 1 })
  let count = 0
  for await (const chunk of stream) { hash.update(chunk); count += chunk.length }
  if (count !== bytes || hash.digest('hex') !== expectedHash) throw new Error('更新包程序归档摘要不匹配')
}

export async function writeUpdateBundle(archive: string, output: string, signed: SignedServerUpdate): Promise<void> {
  const fd = fs.openSync(archive, 'r')
  let destination: number | undefined
  let created = false
  try {
    const manifest = JSON.parse(signed.payload) as { archive: { bytes: number; sha256: string } }
    if (fs.fstatSync(fd).size !== manifest.archive.bytes) throw new Error('更新归档大小不匹配')
    await verifyBundleArchive(fd, 0, manifest.archive.bytes, manifest.archive.sha256)
    destination = fs.openSync(output, 'wx+', 0o644); created = true
    const write = (bytes: Buffer): void => {
      let count = 0
      while (count < bytes.length) {
        const written = fs.writeSync(destination!, bytes, count, bytes.length - count)
        if (!written) throw new Error('更新包写入失败')
        count += written
      }
    }
    write(updateBundlePrefix(signed))
    for await (const bytes of fs.createReadStream('', { fd, autoClose: false, start: 0, end: manifest.archive.bytes - 1 })) write(bytes)
    if (fs.fstatSync(fd).size !== manifest.archive.bytes) throw new Error('更新归档在封装期间发生变化')
    fs.fsyncSync(destination)
    const written = readUpdateBundle(destination)
    if (written.archiveBytes !== manifest.archive.bytes) throw new Error('更新归档在封装期间发生变化')
    await verifyBundleArchive(destination, written.archiveOffset, written.archiveBytes, manifest.archive.sha256)
  } catch (error) {
    if (created) { if (destination !== undefined) { fs.closeSync(destination); destination = undefined }; fs.unlinkSync(output) }
    throw error
  } finally { if (destination !== undefined) fs.closeSync(destination); fs.closeSync(fd) }
}

/** Read only the bounded prefix; caller either consumes the archive or closes
 * it immediately (metadata check). Chunk boundaries may split any header byte. */
export async function openUpdateBundleStream(source: AsyncIterable<Uint8Array>): Promise<{
  signed: unknown; archive: AsyncGenerator<Buffer>; close: () => Promise<void>
}> {
  const iterator = source[Symbol.asyncIterator]()
  let pending = Buffer.alloc(0)
  const take = async (size: number): Promise<Buffer> => {
    const result = Buffer.alloc(size)
    let count = 0
    while (count < size) {
      if (!pending.length) {
        const next = await iterator.next()
        if (next.done) throw new Error('更新包不完整')
        pending = Buffer.from(next.value)
      }
      const amount = Math.min(size - count, pending.length)
      pending.copy(result, count, 0, amount); count += amount
      pending = pending.subarray(amount)
    }
    return result
  }
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await iterator.return?.()
  }
  try {
    const length = manifestLength(await take(UPDATE_BUNDLE_HEADER_BYTES))
    const signed: unknown = JSON.parse((await take(length)).toString('utf8'))
    const archive = (async function* (): AsyncGenerator<Buffer> {
      try {
        if (pending.length) yield pending
        for (;;) { const next = await iterator.next(); if (next.done) break; yield Buffer.from(next.value) }
      } finally { await close() }
    })()
    return { signed, archive, close }
  } catch (error) { await close(); throw error }
}

export async function fetchUpdateBundleManifest(url: string | URL): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: {
    Range: `bytes=0-${UPDATE_BUNDLE_HEADER_BYTES + UPDATE_BUNDLE_MAX_MANIFEST - 1}`, 'Accept-Encoding': 'identity'
  } })
  if (!response.ok || !response.body) throw new Error('官方更新包信息下载失败')
  const prefix = await openUpdateBundleStream(response.body)
  try { return prefix.signed } finally { await prefix.close() }
}
