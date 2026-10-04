import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import type { CatalogBackend } from '../application/catalogBackend'
import type { VideoResource } from '@shared/videoTypes'
import { resourceLocatorRevision } from '@library/catalog/catalogPlay'
import { closeDatabase, initDatabaseAtPath } from '@library/db/database'
import { createMediaLibrary, updateMediaLibraryRoot } from '@library/db/mediaLibraryRepo'
import { createPlaybackSourceResolver } from './playbackSource'
import { PlaybackFailure } from './playbackFailure'

const target = { libraryId: 1, videoId: 2, resourceId: 3 }
function fixture(locator: string, mode: 'local' | 'remote' = 'local') {
  let row: VideoResource | null = {
    id: 3, library_id: 1, video_id: 2, root_id: null, kind: 'local', locator,
    resource_key: 'file:test', source_identity: null, strm_source_path: null,
    size_bytes: null, duration_seconds: null, file_mtime_ms: null, display_name: 'Test',
    is_primary: 1, add_time: '2026-10-03T00:00:00.000Z'
  }
  let epoch = 1
  let status = 'active'
  let queries = 0
  let grantId = 3
  let handle = 'https://server.invalid/play?token=secret'
  const grants: unknown[] = []
  const backend = {
    mode, identity: { mode, catalogId: 'catalog-1', serverId: mode === 'remote' ? 'server-1' : undefined }, generation: 1,
    session: () => ({ state: 'available', writerEpoch: epoch }),
    libraries: { get: async () => ({ status }) },
    queries: { getResource: async () => { queries++; return row } },
    assets: { grantPlayback: async (input: unknown) => { grants.push(input); return { resourceId: grantId, playbackHandle: handle } } }
  } as unknown as CatalogBackend
  return { resolver: createPlaybackSourceResolver(backend), backend, grants, queries: () => queries,
    patch: (value: Partial<VideoResource>) => { row = { ...row!, ...value } },
    epoch: (value: number) => { epoch = value }, status: (value: string) => { status = value },
    grant: (resourceId: number, url: string) => { grantId = resourceId; handle = url } }
}

function managedFixture(t: TestContext) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-playback-managed-source-')))
  t.after(() => {
    closeDatabase()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  initDatabaseAtPath(':memory:')
  const rootPath = path.join(directory, 'media')
  fs.mkdirSync(rootPath)
  const library = createMediaLibrary({ name: 'Playback source', roots: [{ path: rootPath }] })
  const root = library.roots[0]
  const file = path.join(rootPath, 'movie.mp4')
  fs.writeFileSync(file, 'synthetic managed movie')
  const f = fixture(file)
  f.patch({ library_id: library.id, root_id: root.id })
  return { ...f, directory, library, root, file, target: { ...target, libraryId: library.id } }
}

test('a moved managed file is missing while its authorized root remains accessible', async t => {
  const f = managedFixture(t)
  const source = await f.resolver.resolve(f.target)
  await f.resolver.validate(source)
  fs.renameSync(f.file, path.join(f.root.path, 'moved.mp4'))
  await assert.rejects(f.resolver.validate(source), error => error instanceof PlaybackFailure && error.code === 'missing')
  await assert.rejects(f.resolver.resolve(f.target), error => error instanceof PlaybackFailure && error.code === 'missing')
})

for (const state of ['offline', 'changed', 'disabled'] as const) {
  test(`managed sources reject roots that become ${state} on resolve and validate`, async t => {
    const f = managedFixture(t)
    const source = await f.resolver.resolve(f.target)
    if (state === 'disabled') {
      updateMediaLibraryRoot({ libraryId: f.library.id, rootId: f.root.id,
        expectedRevision: f.library.revision, patch: { state: 'disabled' } })
    } else {
      fs.renameSync(f.root.path, path.join(f.directory, 'retired'))
      if (state === 'changed') {
        fs.mkdirSync(f.root.path)
        fs.writeFileSync(f.file, 'replacement on another physical root')
      }
    }
    await assert.rejects(f.resolver.validate(source), error => error instanceof PlaybackFailure && error.code === 'root')
    await assert.rejects(f.resolver.resolve(f.target), error => error instanceof PlaybackFailure && error.code === 'root')
  })
}

test('managed sources do not classify unauthorized outside files as missing', async t => {
  const f = managedFixture(t)
  const outside = path.join(f.directory, 'outside.mp4')
  fs.writeFileSync(outside, 'outside the authorized root')
  f.patch({ locator: outside })
  await assert.rejects(f.resolver.resolve(f.target), error => error instanceof PlaybackFailure && error.code === 'root')
  fs.renameSync(outside, path.join(f.directory, 'moved-outside.mp4'))
  await assert.rejects(f.resolver.resolve(f.target), error => error instanceof PlaybackFailure && error.code === 'root')
  f.patch({ locator: `${f.root.path}${path.sep}..${path.sep}outside.mp4` })
  await assert.rejects(f.resolver.resolve(f.target), error => error instanceof PlaybackFailure && error.code === 'root')
})

test('a managed path beneath a regular file reports missing without losing root authorization', async t => {
  const f = managedFixture(t)
  f.patch({ locator: path.join(f.file, 'missing.mp4') })
  await assert.rejects(f.resolver.resolve(f.target), error => error instanceof PlaybackFailure && error.code === 'missing')
})

test('managed sources still reject canonical symlink escapes', { skip: process.platform === 'win32' }, async t => {
  const f = managedFixture(t)
  const outside = path.join(f.directory, 'outside.mp4')
  fs.writeFileSync(outside, 'outside the authorized root')
  const link = path.join(f.root.path, 'escape.mp4')
  fs.symlinkSync(outside, link)
  f.patch({ locator: link })
  await assert.rejects(f.resolver.resolve(f.target), error => error instanceof PlaybackFailure && error.code === 'root')
})

test('manual files are rechecked; revision fallback is consistent and physical changes isolate resume points', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-playback-source-'))
  try {
    const file = path.join(directory, 'movie.mp4')
    fs.writeFileSync(file, 'synthetic first version')
    const f = fixture(file)
    const source = await f.resolver.resolve(target)
    await f.resolver.validate(source)
    assert.equal(JSON.parse(source.fileIdentity!)[0], fs.realpathSync(file))
    assert.match(source.resumeKey, /^[a-f\d]{64}$/)
    fs.writeFileSync(file, 'synthetic replacement with another size')
    await assert.rejects(f.resolver.validate(source), error => error instanceof PlaybackFailure && error.code === 'identity')
    const replacement = await f.resolver.resolve(target)
    assert.notEqual(replacement.resumeKey, source.resumeKey)
    fs.unlinkSync(file)
    await assert.rejects(f.resolver.validate(replacement), error => error instanceof PlaybackFailure && error.code === 'missing')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('ownership and archive checks run before granting or probing any locator', async () => {
  const f = fixture('/private/nonexistent.mp4')
  f.status('archived')
  await assert.rejects(f.resolver.resolve(target), error => error instanceof PlaybackFailure && error.code === 'library')
  assert.equal(f.queries(), 0)
  f.status('active'); f.patch({ video_id: 4 })
  await assert.rejects(f.resolver.resolve(target), error => error instanceof PlaybackFailure && error.code === 'resource')
  f.patch({ video_id: 2, kind: 'web' })
  await assert.rejects(f.resolver.resolve(target), error => error instanceof PlaybackFailure && error.code === 'unsupported')
  assert.equal(f.grants.length, 0)
})

test('remote sources use a scoped grant and stable progress identity, not credentials or writer epochs', async () => {
  const f = fixture('/server/movie.mkv', 'remote')
  const source = await f.resolver.resolve(target)
  assert.equal(source.locator, 'https://server.invalid/play?token=secret')
  assert.equal(source.revision, resourceLocatorRevision({ kind: 'local', locator: '/server/movie.mkv', source_identity: null,
    root_id: null, size_bytes: null, file_mtime_ms: null }))
  assert.deepEqual(f.grants, [{ ...target, locatorRevision: source.revision }])
  await f.resolver.validate(source)
  assert.equal(f.grants.length, 1, 'validation never acquires another grant')
  f.epoch(2); f.grant(3, 'https://server.invalid/play?token=rotated')
  await assert.rejects(f.resolver.validate(source), error => error instanceof PlaybackFailure && error.code === 'identity')
  const rotated = await f.resolver.resolve(target)
  assert.equal(rotated.resumeKey, source.resumeKey)
  assert.notEqual(rotated.identityKey, source.identityKey)
  assert.ok(!rotated.resumeKey.includes('rotated'))
})

test('mismatched resources, URL credentials and non-HTTP grants are rejected without exposing their values', async () => {
  const f = fixture('/server/movie.mkv', 'remote')
  for (const [id, url] of [[4, 'https://server.invalid/play?token=secret'], [3, 'https://user:secret@server.invalid/play'],
    [3, 'file:///private/movie.mp4'], [3, 'invalid grant']] as const) {
    f.grant(id, url)
    await assert.rejects(f.resolver.resolve(target), error => error instanceof PlaybackFailure && error.code === 'grant' && !error.message.includes('secret'))
  }
})
