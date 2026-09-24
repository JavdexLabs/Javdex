import { afterEach, beforeEach, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resetSettingsCacheForTests } from '../../../apps/desktop/src/main/settings/settingsStore'
import { encryptPlain, resetAssetKeyCacheForTests } from './assetCrypto'
import { aliasStoreAbsAt, resolveMediaAssetsRoot } from './assetStoragePaths'
import { getPathAlias, setPathAlias, removePathAlias, resetPathAliasCacheForTests } from './assetPathAliases'

let root: string
let file: string
let previous: string | undefined
beforeEach(() => {
  previous = process.env.JAVDEX_TEST_USER_DATA
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-alias-journal-'))
  process.env.JAVDEX_TEST_USER_DATA = root
  resetSettingsCacheForTests()
  resetAssetKeyCacheForTests()
  resetPathAliasCacheForTests()
  file = aliasStoreAbsAt(resolveMediaAssetsRoot())
  fs.mkdirSync(path.dirname(file), { recursive: true })
})
afterEach(() => {
  mock.restoreAll()
  resetPathAliasCacheForTests()
  resetAssetKeyCacheForTests()
  resetSettingsCacheForTests()
  if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previous
  fs.rmSync(root, { recursive: true, force: true })
})

it('reads legacy without rewriting and migrates on mutation preserving all entries', () => {
  const legacy = encryptPlain(Buffer.from(JSON.stringify({ a: 'old-a', b: 'old-b' })), '.json')
  fs.writeFileSync(file, legacy)
  assert.equal(getPathAlias('a'), 'old-a')
  assert.deepEqual(fs.readFileSync(file), legacy)
  setPathAlias('c', 'new-c')
  resetPathAliasCacheForTests()
  assert.deepEqual(['a', 'b', 'c'].map(getPathAlias), ['old-a', 'old-b', 'new-c'])
  assert.equal(fs.readFileSync(file).includes(Buffer.from('old-a')), false)
})

it('does not reread a warm map or append unchanged values; reloads deletions', () => {
  setPathAlias('a', 'first')
  const read = mock.method(fs, 'readFileSync')
  setPathAlias('b', 'second')
  setPathAlias('a', 'updated')
  const bytes = fs.statSync(file).size
  setPathAlias('a', 'updated')
  removePathAlias('absent')
  assert.equal(fs.statSync(file).size, bytes)
  assert.equal(getPathAlias('b'), 'second')
  assert.equal(read.mock.callCount(), 0)
  removePathAlias('a')
  resetPathAliasCacheForTests()
  assert.equal(getPathAlias('a'), undefined)
  assert.equal(getPathAlias('b'), 'second')
  removePathAlias('b')
  assert.equal(fs.existsSync(file), false)
})

it('preserves a legacy file when snapshot rename fails', () => {
  const legacy = encryptPlain(Buffer.from('{"a":"first"}'), '.json')
  fs.writeFileSync(file, legacy)
  const rename = mock.method(fs, 'renameSync', () => { throw new Error('disk failure') })
  assert.throws(() => setPathAlias('b', 'second'), /disk failure/)
  assert.deepEqual(fs.readFileSync(file), legacy)
  rename.mock.restore()
  setPathAlias('b', 'second')
  assert.equal(getPathAlias('a'), 'first')
})

it('recovers an interrupted tail and truncates it before retry', () => {
  setPathAlias('a', 'first')
  const bytes = fs.statSync(file).size
  const write = fs.writeSync
  let calls = 0
  const fault = mock.method(fs, 'writeSync', ((fd: number, body: Buffer, offset: number, length: number, position: number) => {
    if (++calls === 1) return write(fd, body, offset, Math.min(12, length), position)
    throw new Error('interrupted')
  }) as typeof fs.writeSync)
  assert.throws(() => setPathAlias('b', 'second'), /interrupted/)
  fault.mock.restore()
  assert.equal(fs.statSync(file).size, bytes + 12)
  assert.equal(getPathAlias('a'), 'first')
  assert.equal(getPathAlias('b'), undefined)
  setPathAlias('b', 'second')
  resetPathAliasCacheForTests()
  assert.equal(getPathAlias('b'), 'second')
  assert.equal(getPathAlias('a'), 'first')
})

it('rejects corrupted complete ciphertext and preserves it on attempted mutation', () => {
  setPathAlias('a', 'first')
  setPathAlias('b', 'second')
  const body = fs.readFileSync(file)
  body[body.length - 1] ^= 1
  fs.writeFileSync(file, body)
  resetPathAliasCacheForTests()
  assert.throws(() => getPathAlias('a'))
  assert.throws(() => setPathAlias('c', 'third'))
  assert.deepEqual(fs.readFileSync(file), body)
})

it('rejects missing or incomplete first snapshots', () => {
  setPathAlias('a', 'first')
  const body = fs.readFileSync(file)
  for (const size of [16, 20, body.length - 1]) {
    fs.writeFileSync(file, body.subarray(0, size))
    resetPathAliasCacheForTests()
    assert.throws(() => getPathAlias('a'))
    assert.equal(fs.statSync(file).size, size)
  }
})

it('reloads the actual committed record after an uncertain fsync failure', () => {
  setPathAlias('a', 'first')
  const fault = mock.method(fs, 'fsyncSync', () => { throw new Error('sync failure') })
  assert.throws(() => setPathAlias('b', 'second'), /sync failure/)
  fault.mock.restore()
  assert.equal(getPathAlias('b'), 'second')
  const bytes = fs.statSync(file).size
  setPathAlias('b', 'second')
  assert.equal(fs.statSync(file).size, bytes)
})

it('compacts after sustained updates and reloads the latest values', () => {
  setPathAlias('a', 'first')
  setPathAlias('b', 'second')
  for (let index = 0; index < 4096; index++) setPathAlias('a', String(index))
  assert.ok(fs.statSync(file).size < 1024)
  resetPathAliasCacheForTests()
  assert.equal(getPathAlias('a'), '4095')
  assert.equal(getPathAlias('b'), 'second')
})

it('preserves the appended result when compaction rename fails', () => {
  setPathAlias('a', 'first')
  // Replay a valid encrypted tail to reach the public compaction threshold without
  // thousands of redundant fsync calls in this fault-only test.
  setPathAlias('b', 'second')
  const body = fs.readFileSync(file)
  const headerSize = Buffer.byteLength('JAVDEX-ALIASES-2\n')
  const snapshotEnd = headerSize + 8 + body.readUInt32LE(headerSize)
  const tail = body.subarray(snapshotEnd)
  fs.appendFileSync(file, Buffer.concat(Array.from({ length: 4094 }, () => tail)))
  resetPathAliasCacheForTests()
  const rename = mock.method(fs, 'renameSync', () => { throw new Error('compaction failure') })
  const log = mock.method(console, 'error', () => {})
  setPathAlias('c', 'third')
  assert.equal(log.mock.callCount(), 1)
  assert.equal(getPathAlias('c'), 'third')
  assert.equal(getPathAlias('a'), 'first')
  rename.mock.restore()
  setPathAlias('d', 'fourth')
  resetPathAliasCacheForTests()
  assert.equal(getPathAlias('d'), 'fourth')
  assert.equal(getPathAlias('c'), 'third')
})

it('invalidates the cached map after external replacement', () => {
  setPathAlias('a', 'first')
  const replacement = `${file}.replacement`
  fs.writeFileSync(replacement, encryptPlain(Buffer.from('{"b":"second"}'), '.json'))
  fs.renameSync(replacement, file)
  assert.equal(getPathAlias('a'), undefined)
  assert.equal(getPathAlias('b'), 'second')
})
