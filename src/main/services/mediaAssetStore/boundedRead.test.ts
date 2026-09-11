import { afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { AssetReadTooLargeError, readBoundedAssetFile } from './boundedRead'

let root: string | undefined
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined })
function fixture(bytes: number): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-bounded-read-'))
  const name = path.join(root, 'image.jpg')
  fs.writeFileSync(name, Buffer.alloc(bytes, 7))
  return name
}

it('reads empty, exact-budget and multi-chunk files without using readFile', async (t) => {
  const name = fixture(0)
  t.mock.method(fs.promises, 'readFile', () => { throw Error('unbounded read forbidden') })
  assert.equal((await readBoundedAssetFile(name, undefined, 0)).length, 0)
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 9, 7)
  fs.writeFileSync(name, bytes)
  assert.deepEqual(await readBoundedAssetFile(name, undefined, bytes.length), bytes)
})

it('rejects oversize before reading and closes the opened handle', async (t) => {
  const name = fixture(9)
  const original = fs.promises.open
  let handle!: FileHandle
  let reads = 0
  t.mock.method(fs.promises, 'open', async (...args: unknown[]) => {
    handle = await Reflect.apply(original, fs.promises, args)
    t.mock.method(handle, 'read', () => { reads++; throw Error('should not read') })
    return handle
  })
  await assert.rejects(readBoundedAssetFile(name, undefined, 8), AssetReadTooLargeError)
  assert.equal(reads, 0)
  assert.equal(handle.fd, -1)
})

for (const change of ['grow', 'truncate', 'cancel', 'io-error'] as const) {
  it(`rejects ${change} during reading and closes the handle`, async (t) => {
    const name = fixture(8)
    const original = fs.promises.open
    const abort = new AbortController()
    let handle!: FileHandle
    let changed = false
    t.mock.method(fs.promises, 'open', async (...args: unknown[]) => {
      handle = await Reflect.apply(original, fs.promises, args)
      const read = handle.read
      t.mock.method(handle, 'read', async (...readArgs: unknown[]) => {
        if (!changed) {
          changed = true
          if (change === 'grow') fs.appendFileSync(name, Buffer.alloc(16))
          if (change === 'truncate') fs.truncateSync(name, 2)
          if (change === 'cancel') abort.abort()
          if (change === 'io-error') throw Error('injected I/O failure')
        }
        return Reflect.apply(read, handle, readArgs)
      })
      return handle
    })
    await assert.rejects(readBoundedAssetFile(name, abort.signal, 8),
      change === 'grow' ? AssetReadTooLargeError : change === 'cancel' ? { name: 'AbortError' } : /changed|I\/O failure/)
    assert.equal(handle.fd, -1)
  })
}

it('does not open an already cancelled request', async (t) => {
  const name = fixture(8)
  const open = t.mock.method(fs.promises, 'open')
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(readBoundedAssetFile(name, abort.signal), { name: 'AbortError' })
  assert.equal(open.mock.callCount(), 0)
})

for (const failure of ['cancel-after-open', 'stat-error', 'directory'] as const) {
  it(`closes the handle on ${failure} before allocating body bytes`, async (t) => {
    const name = fixture(8)
    const original = fs.promises.open
    const abort = new AbortController()
    let handle!: FileHandle
    let reads = 0
    t.mock.method(fs.promises, 'open', async (...args: unknown[]) => {
      handle = await Reflect.apply(original, fs.promises, args)
      t.mock.method(handle, 'read', () => { reads++; throw Error('should not read') })
      if (failure === 'cancel-after-open') abort.abort()
      if (failure === 'stat-error') t.mock.method(handle, 'stat', () => { throw Error('injected stat failure') })
      return handle
    })
    await assert.rejects(readBoundedAssetFile(failure === 'directory' ? root! : name, abort.signal),
      failure === 'cancel-after-open' ? { name: 'AbortError' } : /stat failure|regular file/)
    assert.equal(reads, 0)
    assert.equal(handle.fd, -1)
  })
}
