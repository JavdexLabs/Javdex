import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { crc32 } from 'node:zlib'
import { test } from 'node:test'
import { verifyRuntimePackage, type RuntimePackagePin } from './runtimePackage'
import { createAiRuntimeInstaller } from './runtimeInstaller'
import type { AiRuntimeAsset } from './runtimeManifest'
import { modelDownloadFile, runtimeAssetDirectory } from './modelStorage'

const pin: RuntimePackagePin = { version: 'whisper-b5130-r1', commit: 'a'.repeat(40), runId: 1234, upstreamCommit: 'b'.repeat(40) }
async function fixture(): Promise<{ directory: string; manifest: Record<string, unknown> }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-runtime-package-'))
  const files = []
  for (const name of ['whisper-cli.exe', 'vulkan-1.dll', 'LICENSE-whisper.txt', 'LICENSE-vulkan-loader.txt', 'SOURCE.json']) {
    const bytes = Buffer.from(name === 'SOURCE.json' ? JSON.stringify({ commit: pin.commit, upstream: { commit: pin.upstreamCommit } }) : `fixture ${name}`)
    await fs.writeFile(path.join(directory, name), bytes)
    files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  const manifest = { formatVersion: 1, id: 'whisper', version: pin.version, target: { platform: 'win32', arch: 'x64', backend: 'vulkan' },
    interface: { id: 'whisper-cli', version: 1 }, entry: 'whisper-cli.exe', upstreamVersion: 'b5130', upstreamCommit: pin.upstreamCommit,
    provenance: { repository: 'JavdexLabs/javdex-runtime', commit: pin.commit, runId: pin.runId },
    checks: { cli: 'passed', kotoba: 'passed', vad: 'passed', gpu: 'not-tested' }, files }
  await fs.writeFile(path.join(directory, 'runtime.json'), JSON.stringify(manifest))
  return { directory, manifest }
}
test('the fixed runtime package validates actual payload, source and honest GPU evidence', async t => {
  const { directory } = await fixture()
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await verifyRuntimePackage(directory, pin, 1024 * 1024)
  await fs.appendFile(path.join(directory, 'vulkan-1.dll'), 'tampered')
  await assert.rejects(verifyRuntimePackage(directory, pin, 1024 * 1024), /校验失败/)
})
test('foreign target, interface, provenance, unknown format and extra executable are rejected before installation', async t => {
  for (const change of [{ target: { platform: 'linux', arch: 'x64', backend: 'vulkan' } },
    { interface: { id: 'whisper-cli', version: 2 } }, { formatVersion: 2 },
    { provenance: { repository: 'someone/fork', commit: pin.commit, runId: pin.runId } }]) {
    const { directory, manifest } = await fixture()
    t.after(() => fs.rm(directory, { recursive: true, force: true }))
    await fs.writeFile(path.join(directory, 'runtime.json'), JSON.stringify({ ...manifest, ...change }))
    await assert.rejects(verifyRuntimePackage(directory, pin, 1024 * 1024), /校验失败/)
  }
  const { directory } = await fixture()
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.writeFile(path.join(directory, 'unlisted.exe'), 'unexpected')
  await assert.rejects(verifyRuntimePackage(directory, pin, 1024 * 1024), /校验失败/)
})

/** Independent stored ZIP fixture: exercise the real Windows extractor, not a mocked installer. */
function zip(entries: { name: string; bytes: Buffer }[]): Buffer {
  const records: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name), local = Buffer.alloc(30), header = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc32(entry.bytes), 14); local.writeUInt32LE(entry.bytes.length, 18); local.writeUInt32LE(entry.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6)
    header.writeUInt32LE(crc32(entry.bytes), 16); header.writeUInt32LE(entry.bytes.length, 20); header.writeUInt32LE(entry.bytes.length, 24)
    header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42)
    records.push(local, name, entry.bytes); central.push(header, name)
    offset += local.length + name.length + entry.bytes.length
  }
  const end = Buffer.alloc(22), index = Buffer.concat(central)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...records, index, end])
}

test('Windows installs the verified flat ZIP via resume, reuses it, and retains tools after a rejected replacement', {
  skip: process.platform !== 'win32' ? 'Requires native Windows PowerShell ZIP extraction; not a cross-platform pass' : false
}, async t => {
  const { directory: payload } = await fixture(), root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-runtime-zip-'))
  t.after(() => fs.rm(payload, { recursive: true, force: true }))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const entries = await Promise.all((await fs.readdir(payload)).map(async name => ({ name, bytes: await fs.readFile(path.join(payload, name)) })))
  const packed = zip(entries)
  const entry = (bytes: Buffer): AiRuntimeAsset => ({ id: 'whisper', label: 'Fixture runtime', backend: 'vulkan', archive: true,
    filename: 'fixture.zip', url: 'https://runtime.invalid/fixed.zip', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), expandedBytes: 1024 * 1024, runtimePackage: pin })
  const asset = entry(packed), target = { platform: 'win32', arch: 'x64' }, events: string[] = []
  let requests = 0
  const installer = createAiRuntimeInstaller(root, async (_url, options) => {
    requests++
    assert.equal(new Headers(options?.headers).get('range'), 'bytes=10-')
    return new Response(packed.subarray(10), { status: 206, headers: { 'content-range': `bytes 10-${packed.length - 1}/${packed.length}` } })
  }, [asset], { target })
  const partial = modelDownloadFile(root, asset)
  await fs.mkdir(path.dirname(partial), { recursive: true }); await fs.writeFile(partial, packed.subarray(0, 10))
  await installer.install(new AbortController().signal, () => {}, ['whisper'], event => events.push(event.phase))
  assert.equal(await installer.assetsInstalled(['whisper']), true)
  assert.ok(events.includes('downloading') && events.includes('installing'))
  await installer.install(new AbortController().signal, () => {}, ['whisper'])
  assert.equal(requests, 1)
  const installed = runtimeAssetDirectory(root, 'whisper', target, 'vulkan')
  for (const unsafe of ['../escape.exe', 'unlisted.exe', 'VULKAN-1.dll']) {
    const bad = zip([...entries, { name: unsafe, bytes: Buffer.from('bad') }])
    const rejected = createAiRuntimeInstaller(root, async () => new Response(bad), [entry(bad)], { target })
    await assert.rejects(rejected.install(new AbortController().signal, () => {}, ['whisper']))
    assert.equal(await fs.readFile(path.join(installed, 'whisper-cli.exe'), 'utf8'), 'fixture whisper-cli.exe')
    assert.equal(await installer.assetsInstalled(['whisper']), true)
  }
  await fs.rm(path.join(installed, 'vulkan-1.dll'))
  assert.equal(await installer.assetsInstalled(['whisper']), false)
})
