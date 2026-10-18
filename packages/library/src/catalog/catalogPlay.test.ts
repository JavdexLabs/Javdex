import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { addMediaLibraryRoot } from '@library/db/mediaLibraryRepo'
import { getVideoResourceInLibrary } from '@library/db/videoRepo'
import { insertTestVideoWithFile } from '@library/db/testVideoFixtures'
import { isStructuredError } from '@shared/protocol/errors'
import { ensureCatalogIdentity } from './catalogIdentity'
import { grantCatalogPlayback, inspectPlayStream, pruneExpiredPlayGrants, resourceLocatorRevision, setPlayGrantListener } from './catalogPlay'
import { readCatalogSetting } from './catalogSettings'

describe('catalogPlay locator revision', () => {
  it('changes when the resource locator or fingerprint changes', () => {
    const base = {
      kind: 'local' as const,
      locator: '/media/ABC-001.mp4',
      source_identity: 'local:/media/ABC-001.mp4',
      root_id: 1,
      size_bytes: 16,
      file_mtime_ms: 1000
    }
    const first = resourceLocatorRevision(base)
    assert.equal(first.length, 64)
    assert.equal(resourceLocatorRevision(base), first)
    assert.notEqual(resourceLocatorRevision({ ...base, locator: '/media/ABC-002.mp4' }), first)
    assert.notEqual(resourceLocatorRevision({ ...base, file_mtime_ms: 2000 }), first)
  })
})

it('retains more than 128 grants without eviction and cleans only expired grants and token indexes', t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-play-grant-pool-')))
  t.after(() => { setPlayGrantListener(null); closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }) })
  initDatabaseAtPath(':memory:')
  ensureCatalogIdentity({ serverId: randomUUID() })
  const root = addMediaLibraryRoot({ libraryId: 1, expectedRevision: 1, root: { path: directory } })
  const file = path.join(directory, '原始 影片.mp4')
  fs.writeFileSync(file, 'synthetic media')
  const { videoId, fileId } = insertTestVideoWithFile(getDb(), { code: 'POOL-001', filePath: file, rootId: root.id })
  const input = { libraryId: 1, videoId, resourceId: fileId, locatorRevision: resourceLocatorRevision(getVideoResourceInLibrary(1, fileId)!) }
  const now = Date.now()
  const revoked: string[] = []
  setPlayGrantListener({ onRevoke: ids => { revoked.push(...ids) } })
  const grants = Array.from({ length: 260 }, (_, index) => grantCatalogPlayback(input, {
    deviceId: 'client', now: new Date(now + index), ...(index < 130 ? { ttlMs: 1000 } : {})
  }))
  const inspect = (grant: typeof grants[0]) => inspectPlayStream({ grantId: grant.grantId,
    token: new URL(grant.playbackHandle, 'https://fixture.invalid').searchParams.get('t')!, now: new Date(now + 500) })
  assert.equal(inspect(grants[0]).fileName, '原始 影片.mp4', 'the oldest grant remains valid after 260 issues')
  assert.doesNotThrow(() => inspect(grants[259]))
  assert.deepEqual(revoked, [], 'issuing grants must not revoke any unexpired grant')
  const count = (prefix: string): number => (getDb().prepare('SELECT count(*) AS n FROM catalog_settings WHERE key LIKE ?').get(prefix) as { n: number }).n
  assert.equal(count('play-grant:%'), 260)
  assert.equal(count('play-token:%'), 260)
  const expiredIds = grants.slice(0, 130).map(grant => grant.grantId).sort()
  assert.deepEqual(pruneExpiredPlayGrants(new Date(now + 2000)).sort(), expiredIds)
  assert.deepEqual(revoked.sort(), expiredIds)
  assert.equal(readCatalogSetting(`play-grant:${grants[0].grantId}`, null), null)
  assert.equal(count('play-grant:%'), 130)
  assert.equal(count('play-token:%'), 130)
  assert.doesNotThrow(() => inspect(grants[130]))
  assert.throws(() => inspect(grants[0]), error => isStructuredError(error) && error.code === 'AUTH_REQUIRED')
  const expired = pruneExpiredPlayGrants(new Date(now + 13 * 60 * 60 * 1000))
  assert.equal(expired.length, 130)
  assert.equal(count('play-grant:%') + count('play-token:%'), 0)
})

for (const cause of ['missing', 'rootChanged', 'rootPermission', 'filePermission', 'filePermissionAlias', 'traversalPermission'] as const) {
  it(`playback grants distinguish ${cause} without exposing filesystem paths or granting inaccessible media`, t => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-play-grant-error-')))
    t.after(() => { closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }) })
    initDatabaseAtPath(':memory:')
    ensureCatalogIdentity({ serverId: randomUUID() })
    const mount = path.join(directory, 'media')
    fs.mkdirSync(mount)
    const root = addMediaLibraryRoot({ libraryId: 1, expectedRevision: 1, root: { path: mount } })
    const fileMount = cause === 'filePermissionAlias' ? path.join(directory, 'media-alias') : mount
    // Exercise real canonicalization, including Windows junction/native path handling.
    if (cause === 'filePermissionAlias') fs.symlinkSync(mount, fileMount, process.platform === 'win32' ? 'junction' : 'dir')
    const file = path.join(fileMount, 'movie.mp4')
    fs.writeFileSync(file, 'synthetic movie')
    const { videoId, fileId } = insertTestVideoWithFile(getDb(), { code: 'PLAY-001', filePath: file, rootId: root.id })
    const resource = getVideoResourceInLibrary(1, fileId)!
    const target = { libraryId: 1, videoId, resourceId: fileId, locatorRevision: resourceLocatorRevision(resource) }
    assert.equal(grantCatalogPlayback(target).resourceId, fileId, 'readable media must pass the same inspection')
    let deniedReads = 0
    if (cause === 'missing') fs.unlinkSync(file)
    else if (cause === 'rootChanged') {
      fs.renameSync(mount, path.join(directory, 'retired'))
      fs.mkdirSync(mount)
      fs.writeFileSync(file, 'replacement must remain unauthorized')
    } else if (cause === 'filePermission' || cause === 'filePermissionAlias') {
      const access = fs.accessSync
      const readTarget = fs.realpathSync.native(file)
      if (cause === 'filePermissionAlias') assert.notEqual(file, readTarget)
      t.mock.method(fs, 'accessSync', (...args: Parameters<typeof fs.accessSync>) => {
        if (args[0] === readTarget) {
          assert.equal(args[1], fs.constants.R_OK)
          deniedReads++
          throw Object.assign(new Error(`EACCES ${readTarget}`), { code: 'EACCES' })
        }
        return access(...args)
      })
    } else {
      const realpath = fs.realpathSync.native
      t.mock.method(fs.realpathSync, 'native', (value: fs.PathLike, ...args: unknown[]) => {
        if (value === (cause === 'rootPermission' ? mount : file)) {
          throw Object.assign(new Error(`EACCES ${value}`), { code: 'EACCES' })
        }
        return Reflect.apply(realpath, fs.realpathSync, [value, ...args])
      })
    }
    const before = getDb().prepare("SELECT key FROM catalog_settings WHERE key LIKE 'play-grant:%'").all().length
    assert.throws(() => grantCatalogPlayback(target), error => {
      assert.ok(isStructuredError(error))
      assert.equal(error.code, cause === 'missing' ? 'FILE_MISSING' : cause === 'rootChanged' ? 'ROOT_OFFLINE' : 'FILE_ACCESS_DENIED')
      assert.ok(!JSON.stringify(error).includes(directory), 'controlled errors must withhold host paths')
      return true
    })
    assert.equal(deniedReads, cause === 'filePermission' || cause === 'filePermissionAlias' ? 1 : 0)
    assert.equal(getDb().prepare("SELECT key FROM catalog_settings WHERE key LIKE 'play-grant:%'").all().length, before)
  })
}
