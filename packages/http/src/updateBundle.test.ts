import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { updateBundlePrefix, readUpdateBundle, writeUpdateBundle, verifyBundleArchive, openUpdateBundleStream, fetchUpdateBundleManifest } from './updateBundle'
import { uploadServerUpdateBundle } from './updateClient'
import type { SignedServerUpdate, ServerUpdateSnapshot } from '@shared/serverUpdateTypes'

const archive = Buffer.from('unchanged compressed program archive fixture')
const signed: SignedServerUpdate = { keyId: 'test', signature: 'fixture-not-a-signature', payload: JSON.stringify({ archive: {
  bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex')
} }) }
test('bundle preserves one signed manifest and exactly the original archive bytes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-bundle-test-'))
  try {
    const input = path.join(directory, 'program.tar.gz'), output = path.join(directory, 'program.javdex-update')
    fs.writeFileSync(input, archive)
    await writeUpdateBundle(input, output, signed)
    const fd = fs.openSync(output, 'r')
    try {
      const result = readUpdateBundle(fd)
      assert.deepEqual(result.signed, signed)
      assert.equal(result.archiveBytes, archive.length)
      assert.deepEqual(fs.readFileSync(output).subarray(result.archiveOffset), archive)
      await verifyBundleArchive(fd, result.archiveOffset, result.archiveBytes, JSON.parse(signed.payload).archive.sha256)
      await assert.rejects(verifyBundleArchive(fd, result.archiveOffset, result.archiveBytes, '0'.repeat(64)), /摘要/)
    } finally { fs.closeSync(fd) }
    await assert.rejects(writeUpdateBundle(input, output, signed), /EEXIST/)
    const raw = fs.openSync(input, 'r')
    try { assert.throws(() => readUpdateBundle(raw), /支持/) } finally { fs.closeSync(raw) }
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('invalid magic, truncated header/body and oversized manifest fail before extraction', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-bundle-invalid-'))
  try {
    const prefix = updateBundlePrefix(signed)
    const oversized = Buffer.from(prefix.subarray(0, 12)); oversized.writeUInt32BE(65537, 8)
    for (const bytes of [Buffer.from('old JSON + tar format'), prefix.subarray(0, 8), prefix, oversized]) {
      const file = path.join(directory, 'invalid'); fs.writeFileSync(file, bytes)
      const fd = fs.openSync(file, 'r')
      try { assert.throws(() => readUpdateBundle(fd), /支持|完整|大小/) } finally { fs.closeSync(fd) }
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('stream prefix works at every byte boundary; metadata-only closes without consuming archive', async () => {
  const prefix = updateBundlePrefix(signed), content = Buffer.concat([prefix, archive])
  let closed = false
  const source = (async function* () {
    try { for (const byte of content) yield Buffer.from([byte]) } finally { closed = true }
  })()
  const result = await openUpdateBundleStream(source)
  assert.deepEqual(result.signed, signed)
  const chunks = []
  for await (const chunk of result.archive) chunks.push(chunk)
  assert.deepEqual(Buffer.concat(chunks), archive)
  assert.equal(closed, true)
  let reachedBody = false
  const metadata = await openUpdateBundleStream((async function* () {
    yield prefix; reachedBody = true; yield archive
  })())
  await metadata.close()
  assert.equal(reachedBody, false)
  await assert.rejects(openUpdateBundleStream((async function* () { yield Buffer.from('invalid') })()), /完整/)
})

test('online metadata requests bounded prefix and accepts no legacy JSON document', async () => {
  const prefix = updateBundlePrefix(signed)
  const server = createServer((request, response) => {
    assert.equal(request.headers.range, 'bytes=0-65547')
    response.end(request.url === '/legacy' ? JSON.stringify(signed) : Buffer.concat([prefix, archive]))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  try {
    assert.deepEqual(await fetchUpdateBundleManifest(`http://127.0.0.1:${address.port}/bundle`), signed)
    await assert.rejects(fetchUpdateBundleManifest(`http://127.0.0.1:${address.port}/legacy`), /支持/)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('large offline file uploads bounded inner chunks and rejects stalled progress', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-bundle-chunks-'))
  const bytes = Buffer.alloc(8 * 1024 ** 2 + 3, 42)
  const selected: SignedServerUpdate = { keyId: 'test', signature: 'fixture', payload: JSON.stringify({
    format: 1, version: '0.9.0', build: 'a'.repeat(40), expiresAt: '2099-01-01T00:00:00.000Z',
    platform: 'linux/amd64', sourceSchemas: [20], targetSchema: 20, minUpdaterProtocol: 1, runtime: 'node22-bookworm-v1',
    archive: { url: 'https://github.com/JavdexLabs/Javdex/releases/download/v0.9.0/fixture.javdex-update',
      bytes: bytes.length, unpackedBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }) }
  const file = path.join(directory, 'fixture.javdex-update')
  fs.writeFileSync(file, Buffer.concat([updateBundlePrefix(selected), bytes]))
  const status: ServerUpdateSnapshot = { protocolVersion: 1, paired: true, serverId: 'fixture', catalogId: 'fixture',
    currentVersion: '0.8.0', platform: 'linux/amd64', targetVersion: '0.9.0', job: {
      id: 'fixture', version: '0.9.0', phase: 'preparing', receivedBytes: 0, totalBytes: bytes.length, updatedAt: 'fixture', message: null
    } }
  const offsets: number[] = []
  const fd = fs.openSync(file, 'r')
  try {
    const result = await uploadServerUpdateBundle({ import: async () => structuredClone(status), upload: async (id, offset, chunk) => {
      assert.equal(id, 'fixture'); offsets.push(offset)
      assert.ok(chunk.length <= 8 * 1024 ** 2)
      assert.deepEqual(chunk, bytes.subarray(offset, offset + chunk.length))
      return { ...status, job: { ...status.job!, receivedBytes: offset + chunk.length, phase: offset + chunk.length === bytes.length ? 'prepared' : 'preparing' } }
    } }, fd)
    assert.deepEqual(offsets, [0, 8 * 1024 ** 2])
    assert.equal(result.job?.phase, 'prepared')
    await assert.rejects(uploadServerUpdateBundle({ import: async () => status, upload: async () => status }, fd), /进度/)
    fs.appendFileSync(file, 'extra')
    await assert.rejects(uploadServerUpdateBundle({ import: async () => { assert.fail('Wrong-size bundle must not create a server job') }, upload: async () => status }, fd), /大小/)
  } finally { fs.closeSync(fd); fs.rmSync(directory, { recursive: true, force: true }) }
})
