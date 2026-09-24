import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { closeDatabase, initDatabaseAtPath } from '@library/db/database'
import { createMediaLibrary } from '@library/db/mediaLibraryRepo'
import { createDefaultLocalNfoSourceAdapter } from './localNfoSourceAdapter'
import { resetSettingsCacheForTests } from '../settings/settingsStore'

for (const failFirstListing of [false, true]) {
it(failFirstListing
  ? 'retries a failed production listing per anchor and starts fresh on the next collect'
  : 'reads one production directory snapshot per collect and refreshes sidecars and siblings next time', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-production-nfo-'))
  const media = path.join(directory, 'media')
  fs.mkdirSync(media)
  const previous = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = directory
  resetSettingsCacheForTests()
  try {
    const db = initDatabaseAtPath(path.join(directory, 'catalog.db'))
    const library = createMediaLibrary({ name: 'NFO snapshot', roots: [{ path: media }] })
    db.prepare("INSERT INTO videos(id,code) VALUES(1,'ABC-001')").run()
    db.prepare("INSERT INTO library_video_memberships(library_id,video_id,discovery_key) VALUES(?,1,1)").run(library.id)
    const insert = db.prepare(`INSERT INTO video_resources
      (library_id,video_id,root_id,kind,locator,resource_key,source_identity)
      VALUES(?,1,?,'local',?,?,?)`)
    for (let index = 1; index <= 24; index++) {
      const file = path.join(media, `ABC-001-CD${index}.mp4`)
      fs.writeFileSync(file, '')
      insert.run(library.id, library.roots[0].id, file, file, file)
    }
    const movie = path.join(media, 'movie.nfo')
    const writeMovie = (title: string) => fs.writeFileSync(movie, `<movie><num>ABC-001</num><title>${title}</title></movie>`)
    writeMovie('Initial exact title')
    const original = fs.readdirSync
    let reads = 0
    let shouldFail = failFirstListing
    t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof fs.readdirSync>) => {
      if (String(args[0]) === media) {
        reads++
        if (shouldFail) {
          shouldFail = false
          throw new Error('first directory listing failed')
        }
      }
      return Reflect.apply(original, fs, args)
    })
    const adapter = createDefaultLocalNfoSourceAdapter()
    const collect = () => adapter.collect({ target: { kind: 'video', videoId: 1, code: 'ABC-001' }, fields: ['title'] })
    assert.equal((await collect()).candidates[0]?.result.title, 'Initial exact title')
    // Failure remains uncached: next list anchor succeeds, then the first anchor retries in collect.
    assert.equal(reads, failFirstListing ? 3 : 1)
    reads = 0
    assert.equal((await collect()).candidates[0]?.result.title, 'Initial exact title')
    assert.equal(reads, 1)
    reads = 0
    fs.unlinkSync(movie)
    assert.equal((await collect()).candidates.length, 0)
    assert.equal(reads, 1)
    writeMovie('Fresh title')
    const sibling = path.join(media, 'OTHER-002.mp4')
    fs.writeFileSync(sibling, '')
    reads = 0
    assert.equal((await collect()).candidates.length, 0)
    assert.equal(reads, 1)
    fs.unlinkSync(sibling)
    reads = 0
    assert.equal((await collect()).candidates[0]?.result.title, 'Fresh title')
    assert.equal(reads, 1)
  } finally {
    t.mock.restoreAll()
    closeDatabase()
    resetSettingsCacheForTests()
    if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previous
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
}

it('does not retain rejected sidecar maps in production anchors beyond 64 scopes', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-production-nfo-budget-'))
  const media = path.join(directory, 'media')
  fs.mkdirSync(media)
  const previous = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = directory
  try {
    const db = initDatabaseAtPath(path.join(directory, 'catalog.db'))
    const library = createMediaLibrary({ name: 'NFO bounded snapshot', roots: [{ path: media }] })
    db.prepare("INSERT INTO videos(id,code) VALUES(1,'ABC-001')").run()
    db.prepare('INSERT INTO library_video_memberships(library_id,video_id,discovery_key) VALUES(?,1,1)').run(library.id)
    const insert = db.prepare(`INSERT INTO video_resources
      (library_id,video_id,root_id,kind,locator,resource_key,source_identity)
      VALUES(?,1,?,'local',?,?,?)`)
    for (let index = 0; index < 65; index++) {
      const folder = path.join(media, String(index))
      fs.mkdirSync(folder)
      fs.writeFileSync(path.join(folder, 'movie.nfo'), '<movie><num>ABC-001</num><title>Complete title</title></movie>')
      const file = path.join(folder, 'ABC-001.mp4')
      fs.writeFileSync(file, '')
      insert.run(library.id, library.roots[0].id, file, file, file)
    }
    const adapter = createDefaultLocalNfoSourceAdapter()
    const original = adapter.collectFromAnchors.bind(adapter)
    let observed = false
    t.mock.method(adapter, 'collectFromAnchors', (...[request, anchors]: Parameters<typeof original>) => {
      assert.equal(anchors.length, 65)
      assert.equal(anchors.filter((anchor) => anchor.directorySidecars !== undefined).length, 64)
      assert.equal(anchors[64].directorySidecars, undefined)
      assert.deepEqual(anchors[64].directoryVideoCodes, {
        kind: 'summary', count: 1, normalizedCode: 'ABC-001', consistent: true
      })
      observed = true
      return original(request, anchors)
    })
    const result = await adapter.collect({ target: { kind: 'video', videoId: 1, code: 'ABC-001' }, fields: ['title'] })
    assert.equal(observed, true)
    assert.equal(result.candidates.length, 65)
    assert.ok(result.candidates.every((candidate) => candidate.result.title === 'Complete title'))
  } finally {
    t.mock.restoreAll()
    closeDatabase()
    if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previous
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
