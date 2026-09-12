import { afterEach, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, initDatabaseAtPath } from '@library/db/database'
import { createMediaLibrary } from '@library/db/mediaLibraryRepo'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import {
  LocalNfoSourceAdapter, createDefaultNfoFileStore, createDefaultLocalNfoSourceAdapter,
  type LocalNfoAnchor
} from './localNfoSourceAdapter'

let directory: string, media: string, previousUserData: string | undefined
beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-nfo-snapshot-'))
  media = path.join(directory, 'media'); fs.mkdirSync(media)
  process.env.JAVDEX_TEST_USER_DATA = directory
})
afterEach(() => {
  closeDatabase(); resetSettingsCacheForTests()
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  fs.rmSync(directory, { recursive: true, force: true })
})
const request = { target: { kind: 'video' as const, videoId: 1, code: 'ABC-001' }, fields: ['title' as const] }
function fixture(count = 3) {
  const db = initDatabaseAtPath(path.join(directory, 'catalog.db'))
  const library = createMediaLibrary({ name: 'NFO snapshot', roots: [{ path: media }] })
  const anchors: LocalNfoAnchor[] = Array.from({ length: count }, (_, index) => {
    const stem = `ABC-001-CD${index + 1}`
    fs.writeFileSync(path.join(media, `${stem}.mp4`), 'synthetic video')
    fs.writeFileSync(path.join(media, `${stem}.nfo`), `<movie><num>ABC-001</num><title>Part ${index + 1}</title></movie>`)
    return { root: library.roots[0], anchorPath: path.join(media, `${stem}.mp4`), directoryVideoCodes: Array(count).fill('ABC-001') }
  })
  const fileStore = createDefaultNfoFileStore()
  const source = new LocalNfoSourceAdapter({ listAnchors: () => anchors, fileStore, findExistingActorGender: () => null })
  return { db, library, anchors, fileStore, source }
}
function sidecars(): ReadonlyMap<string, string> {
  return new Map(fs.readdirSync(media).filter(name => name.endsWith('.nfo')).map(name => [name, name]))
}

it('reads a successful directory once for three direct anchors with complete candidate equality', async context => {
  const current = fixture()
  const supplied = sidecars()
  const baseline = await current.source.collectFromAnchors(request, current.anchors.map(anchor => ({ ...anchor, directorySidecars: supplied })))
  assert.deepEqual(baseline.candidates.map(candidate => candidate.result.title), ['Part 1', 'Part 2', 'Part 3'])
  const original = fs.readdirSync
  let reads = 0
  context.mock.method(fs, 'readdirSync', (...args: unknown[]) => {
    if (args[0] === media) reads++
    return Reflect.apply(original, fs, args)
  })
  const actual = await current.source.collectFromAnchors(request, current.anchors)
  assert.deepEqual(actual, baseline)
  assert.equal(reads, 1)
})


it('does not cache a failed directory read and retries the next anchor', async context => {
  const current = fixture()
  const original = fs.readdirSync
  let reads = 0
  context.mock.method(fs, 'readdirSync', (...args: unknown[]) => {
    if (args[0] === media && ++reads === 1) throw new Error('transient directory read failure')
    return Reflect.apply(original, fs, args)
  })
  const result = await current.source.collectFromAnchors(request, current.anchors)
  assert.deepEqual(result.candidates.map(candidate => candidate.result.title), ['Part 2', 'Part 3'])
  assert.equal(reads, 2, 'first failure is anchor-local; subsequent success is reused')
})

it('refreshes sidecars on each call while keeping explicitly supplied identities authoritative', async context => {
  const current = fixture()
  for (let index = 1; index <= 3; index++) fs.unlinkSync(path.join(media, `ABC-001-CD${index}.nfo`))
  const original = fs.readdirSync
  let reads = 0
  context.mock.method(fs, 'readdirSync', (...args: unknown[]) => {
    if (args[0] === media) reads++
    return Reflect.apply(original, fs, args)
  })
  assert.equal((await current.source.collectFromAnchors(request, current.anchors)).candidates.length, 0)
  assert.equal(reads, 1)
  fs.writeFileSync(path.join(media, 'movie.nfo'), '<movie><num>ABC-001</num><title>New movie</title></movie>')
  fs.writeFileSync(path.join(media, 'OTHER-002.mp4'), 'new sibling')
  const supplied = await current.source.collectFromAnchors(request, current.anchors)
  assert.deepEqual(supplied.candidates.map(candidate => candidate.result.title), ['New movie'])
  assert.equal(reads, 2)
  const mixed = await current.source.collectFromAnchors(request, current.anchors.map(anchor => ({ ...anchor, directoryVideoCodes: ['ABC-001', 'OTHER-002'] })))
  assert.equal(mixed.candidates.length, 0)
  assert.ok(mixed.warnings.length > 0)
  assert.equal(reads, 3, 'no successful snapshot leaks into a later call')
})

it('preserves explicit maps including empty maps and does not overwrite them from the filesystem', async context => {
  const current = fixture()
  fs.writeFileSync(path.join(media, 'movie.nfo'), '<movie><num>ABC-001</num><title>Movie fallback</title></movie>')
  let reads = 0
  context.mock.method(fs, 'readdirSync', () => { reads++; throw new Error('explicit maps must not read directories') })
  const exact = 'ABC-001-CD2.nfo'
  const result = await current.source.collectFromAnchors(request, [
    { ...current.anchors[0], directorySidecars: new Map() },
    { ...current.anchors[1], directorySidecars: new Map([[exact, exact]]) },
    { ...current.anchors[2], directorySidecars: new Map([['movie.nfo', 'movie.nfo']]) }
  ])
  assert.deepEqual(result.candidates.map(candidate => candidate.result.title), ['Part 2', 'Movie fallback'])
  assert.deepEqual(result.warnings, [])
  assert.equal(reads, 0)
})

it('preserves exact-sidecar precedence and warnings over movie.nfo with a cached directory', async context => {
  const current = fixture()
  fs.writeFileSync(path.join(media, 'movie.nfo'), '<movie><num>ABC-001</num><title>Different fallback</title></movie>')
  const supplied = sidecars()
  const baseline = await current.source.collectFromAnchors(request, current.anchors.map(anchor => ({ ...anchor, directorySidecars: supplied })))
  assert.equal(baseline.warnings.length, 3)
  const original = fs.readdirSync
  let reads = 0
  context.mock.method(fs, 'readdirSync', (...args: unknown[]) => {
    if (args[0] === media) reads++
    return Reflect.apply(original, fs, args)
  })
  const actual = await current.source.collectFromAnchors(request, current.anchors)
  assert.deepEqual(actual, baseline)
  assert.deepEqual(actual.candidates.map(candidate => candidate.result.title), ['Part 1', 'Part 2', 'Part 3'])
  assert.equal(reads, 1)
})

it('does not seed shared directory state from an explicitly empty anchor map', async context => {
  const current = fixture()
  const original = fs.readdirSync
  let reads = 0
  context.mock.method(fs, 'readdirSync', (...args: unknown[]) => {
    if (args[0] === media) reads++
    return Reflect.apply(original, fs, args)
  })
  const result = await current.source.collectFromAnchors(request, [
    { ...current.anchors[0], directorySidecars: new Map() },
    current.anchors[1], current.anchors[2]
  ])
  assert.deepEqual(result.candidates.map(candidate => candidate.result.title), ['Part 2', 'Part 3'])
  assert.equal(reads, 1)
})

it('separates a foreign root scope at the same lexical directory and still rejects its outside anchor', async context => {
  const current = fixture()
  const otherPath = path.join(directory, 'other-root')
  fs.mkdirSync(otherPath)
  const other = createMediaLibrary({ name: 'Other scope', roots: [{ path: otherPath }] })
  const original = fs.readdirSync
  let reads = 0
  context.mock.method(fs, 'readdirSync', (...args: unknown[]) => {
    if (args[0] === media) reads++
    return Reflect.apply(original, fs, args)
  })
  const result = await current.source.collectFromAnchors(request, [
    current.anchors[0], { ...current.anchors[1], root: other.roots[0] }, current.anchors[2]
  ])
  assert.deepEqual(result.candidates.map(candidate => candidate.result.title), ['Part 1', 'Part 3'])
  assert.equal(result.warnings.length, 1, 'foreign root cannot authorize an anchor outside its own directory')
  assert.equal(reads, 2)
})

it('still authorizes every file after a root is revoked within a cached-directory collection', async context => {
  const current = fixture()
  let attempts = 0, reads = 0, revoked = false
  const original = fs.readdirSync
  context.mock.method(fs, 'readdirSync', (...args: unknown[]) => {
    if (args[0] === media) reads++
    return Reflect.apply(original, fs, args)
  })
  const source = new LocalNfoSourceAdapter({
    listAnchors: () => current.anchors, findExistingActorGender: () => null,
    fileStore: {
      ...current.fileStore,
      issue: (root, filePath) => { attempts++; return current.fileStore.issue(root, filePath) },
      readBytes: (capability, maxBytes) => {
        const bytes = current.fileStore.readBytes(capability, maxBytes)
        if (!revoked) {
          revoked = true
          current.db.prepare("UPDATE media_library_roots SET state='disabled' WHERE id=?").run(current.library.roots[0].id)
        }
        return bytes
      }
    }
  })
  const result = await source.collectFromAnchors(request, current.anchors)
  assert.equal(revoked, true)
  assert.equal(attempts, 3)
  assert.deepEqual(result.candidates.map(candidate => candidate.result.title), ['Part 1'])
  assert.equal(result.warnings.length, 2)
  assert.equal(reads, 1, 'reusing filenames cannot bypass per-file root authorization')
})


function oversizedSidecarNames(): string[] {
  // Synthetic directory entries only: real exact sidecars remain on disk.
  const names = Array.from({ length: 5000 }, (_, index) => `${'X'.repeat(220)}-${index}.NFO`)
  assert.ok(Buffer.byteLength(JSON.stringify(names)) > 1024 * 1024)
  return names
}

it('does not retain an oversized direct sidecar map while preserving all real exact candidates', async context => {
  const current = fixture()
  const baseline = await current.source.collectFromAnchors(request, current.anchors)
  assert.equal(baseline.candidates.length, 3)
  const extraNames = oversizedSidecarNames()
  const original = fs.readdirSync
  let reads = 0
  context.mock.method(fs, 'readdirSync', (...args: unknown[]) => {
    const names = Reflect.apply(original, fs, args)
    if (args[0] === media) { reads++; return [...names, ...extraNames] }
    return names
  })
  const actual = await current.source.collectFromAnchors(request, current.anchors)
  assert.deepEqual(actual, baseline)
  assert.equal(reads, 3, 'each anchor uses but does not retain the oversized map')
})

it('does not hide oversized maps on production anchors, retaining the ordinary one-read baseline', async context => {
  const current = fixture(24)
  current.db.prepare("INSERT INTO videos(id,code) VALUES(1,'ABC-001')").run()
  current.db.prepare('INSERT INTO library_video_memberships(library_id,video_id,discovery_key) VALUES(?,1,1)').run(current.library.id)
  const insert = current.db.prepare(`INSERT INTO video_resources
    (library_id,video_id,root_id,kind,locator,resource_key,source_identity)
    VALUES(?,1,?,'local',?,?,?)`)
  for (const anchor of current.anchors) insert.run(current.library.id, anchor.root.id, anchor.anchorPath, anchor.anchorPath, anchor.anchorPath)
  const source = createDefaultLocalNfoSourceAdapter(current.fileStore)
  const extraNames = oversizedSidecarNames()
  const original = fs.readdirSync
  let reads = 0, oversized = false
  context.mock.method(fs, 'readdirSync', (...args: unknown[]) => {
    const names = Reflect.apply(original, fs, args)
    if (args[0] === media) { reads++; return oversized ? [...names, ...extraNames] : names }
    return names
  })
  const baseline = await source.collect(request)
  assert.equal(baseline.candidates.length, 24)
  assert.equal(reads, 1)
  oversized = true; reads = 0
  const actual = await source.collect(request)
  assert.deepEqual(actual, baseline)
  assert.equal(reads, 48, '24 production identity reads plus 24 uncached sidecar reads; no hidden retained maps')
})

it('admits at most 64 scopes without evicting earlier successful snapshots', async context => {
  const current = fixture(0)
  const anchors: LocalNfoAnchor[] = []
  for (let index = 0; index < 65; index++) {
    const folder = path.join(media, `scope-${index}`)
    fs.mkdirSync(folder)
    const file = path.join(folder, 'ABC-001.mp4')
    fs.writeFileSync(file, 'video')
    fs.writeFileSync(path.join(folder, 'ABC-001.nfo'), `<movie><num>ABC-001</num><title>Scope ${index}</title></movie>`)
    anchors.push({ root: current.library.roots[0], anchorPath: file, directoryVideoCodes: ['ABC-001'] })
  }
  const original = fs.readdirSync
  const reads = new Map<string, number>()
  context.mock.method(fs, 'readdirSync', (...args: unknown[]) => {
    const dir = String(args[0])
    if (dir.startsWith(`${media}${path.sep}`)) reads.set(dir, (reads.get(dir) ?? 0) + 1)
    return Reflect.apply(original, fs, args)
  })
  const actual = await current.source.collectFromAnchors(request, [...anchors, anchors[0], anchors[64]])
  assert.deepEqual(actual.candidates.map(candidate => candidate.result.title), Array.from({ length: 65 }, (_, index) => `Scope ${index}`))
  assert.equal(reads.size, 65)
  for (let index = 0; index < 64; index++) assert.equal(reads.get(path.dirname(anchors[index].anchorPath)), 1)
  assert.equal(reads.get(path.dirname(anchors[64].anchorPath)), 2)
})
