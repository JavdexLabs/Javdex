import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { createPlaybackResumeStore, playbackResumeKey } from './playbackResumeStore'

const identity = { mode: 'remote' as const, catalogId: 'catalog-one', serverId: 'server-one' }
const key = (resourceId = 1, revision = 'revision-one') => playbackResumeKey(identity, resourceId, revision)
function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-resume-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'playback-progress.json')
  let enabled = false
  let time = 1800000000000
  return { file, directory, store: createPlaybackResumeStore(file, () => enabled, () => time),
    enable: (value = true) => { enabled = value }, advance: (ms: number) => { time += ms }, now: () => time }
}

test('disabled and private sessions neither read malformed data nor write/delete/clean it', t => {
  const f = fixture(t)
  f.store.save(key(), { position: 60, duration: 300 })
  assert.equal(fs.existsSync(f.file), false)
  fs.writeFileSync(f.file, 'old or malformed progress')
  assert.equal(f.store.get(key()), null)
  f.store.save(key(), null)
  f.enable()
  assert.equal(f.store.get(key(), true), null)
  f.store.save(key(), { position: 90, duration: 300 }, true)
  f.store.save(key(), null, true)
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'old or malformed progress')
  assert.throws(() => f.store.get(key()), /无法读取/)
  assert.throws(() => f.store.save(key(), { position: 60, duration: 300 }), /无法读取/)
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'old or malformed progress')
})

test('stable identities distinguish catalogs, servers, resources and revisions without storing locators', t => {
  const f = fixture(t); f.enable()
  const privateRevision = 'https://server.invalid/video?token=private/path'
  const digest = key(1, privateRevision)
  const rotatedSession = { ...identity, writerEpoch: 99, generation: 42, state: 'available' }
  assert.equal(playbackResumeKey(rotatedSession, 1, privateRevision), digest, 'authorization rotation is not content identity')
  f.store.save(digest, { position: 60, duration: 300 })
  assert.deepEqual(f.store.get(digest), { position: 60, duration: 300 })
  for (const other of [key(2, privateRevision), key(1, 'new-revision'),
    playbackResumeKey({ ...identity, catalogId: 'restored-catalog' }, 1, privateRevision),
    playbackResumeKey({ ...identity, serverId: 'other-server' }, 1, privateRevision),
    playbackResumeKey({ mode: 'local', catalogId: identity.catalogId }, 1, privateRevision)]) {
    assert.equal(f.store.get(other), null)
  }
  const onDisk = fs.readFileSync(f.file, 'utf8')
  assert.ok(!/https|token|private|server-one|catalog-one/.test(onDisk))
  assert.deepEqual(fs.readdirSync(f.directory), ['playback-progress.json'])
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o600)
})

test('start/end thresholds and EOF remove only the matching record, explicit clear works while disabled', t => {
  const f = fixture(t); f.enable()
  f.store.save(key(), { position: 29, duration: 300 })
  assert.equal(fs.existsSync(f.file), false)
  f.store.save(key(), { position: 30, duration: null })
  f.store.save(key(2), { position: 80, duration: 300 })
  assert.equal(f.store.get(key())?.position, 30)
  f.store.save(key(), { position: 270, duration: 300 })
  assert.equal(f.store.get(key()), null)
  f.store.save(key(), { position: 60, duration: 300 })
  f.store.save(key(), null)
  assert.equal(f.store.get(key()), null)
  assert.equal(f.store.get(key(2))?.position, 80)
  f.enable(false)
  f.store.clearConfirmed(key(2))
  f.enable()
  assert.equal(f.store.get(key(2)), null)
  f.enable(false)
  f.store.clearConfirmed()
  assert.equal(fs.existsSync(f.file), false)
})

test('retention caps at 1000 most recent entries and expires after 90 days without read-side writes', t => {
  const f = fixture(t); f.enable()
  fs.writeFileSync(f.file, JSON.stringify({ version: 1, entries: Array.from({ length: 1000 }, (_, index) => ({
    key: key(index + 1), position: 60, duration: 300, updatedAt: f.now() - 1000 + index
  })) }))
  f.store.save(key(1001), { position: 90, duration: 300 })
  assert.equal(f.store.get(key(1)), null)
  assert.equal(f.store.get(key(1001))?.position, 90)
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).entries.length, 1000)
  const before = fs.readFileSync(f.file, 'utf8')
  f.advance(90 * 24 * 60 * 60 * 1000 + 1)
  assert.equal(f.store.get(key(1001)), null)
  assert.equal(fs.readFileSync(f.file, 'utf8'), before)
  f.store.save(key(1002), { position: 100, duration: 300 })
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).entries.length, 1)
})

test('explicit clearing of one resource while disabled does not clean unrelated expired records', t => {
  const f = fixture(t); f.enable()
  f.store.save(key(), { position: 60, duration: 300 })
  f.store.save(key(2), { position: 90, duration: 300 })
  f.enable(false)
  f.advance(91 * 24 * 60 * 60 * 1000)
  f.store.clearConfirmed(key())
  const entries = JSON.parse(fs.readFileSync(f.file, 'utf8')).entries
  assert.equal(entries.length, 1)
  assert.equal(entries[0].key, key(2))
})
