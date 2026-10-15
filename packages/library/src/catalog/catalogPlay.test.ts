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
import { grantCatalogPlayback, resourceLocatorRevision } from './catalogPlay'

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

for (const cause of ['missing', 'rootChanged', 'rootPermission', 'filePermission', 'traversalPermission'] as const) {
  it(`playback grants distinguish ${cause} without exposing filesystem paths or granting inaccessible media`, t => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-play-grant-error-')))
    t.after(() => { closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }) })
    initDatabaseAtPath(':memory:')
    ensureCatalogIdentity({ serverId: randomUUID() })
    const mount = path.join(directory, 'media')
    fs.mkdirSync(mount)
    const root = addMediaLibraryRoot({ libraryId: 1, expectedRevision: 1, root: { path: mount } })
    const file = path.join(mount, 'movie.mp4')
    fs.writeFileSync(file, 'synthetic movie')
    const { videoId, fileId } = insertTestVideoWithFile(getDb(), { code: 'PLAY-001', filePath: file, rootId: root.id })
    const resource = getVideoResourceInLibrary(1, fileId)!
    const target = { libraryId: 1, videoId, resourceId: fileId, locatorRevision: resourceLocatorRevision(resource) }
    assert.equal(grantCatalogPlayback(target).resourceId, fileId, 'readable media must pass the same inspection')
    if (cause === 'missing') fs.unlinkSync(file)
    else if (cause === 'rootChanged') {
      fs.renameSync(mount, path.join(directory, 'retired'))
      fs.mkdirSync(mount)
      fs.writeFileSync(file, 'replacement must remain unauthorized')
    } else if (cause === 'filePermission') {
      const access = fs.accessSync
      t.mock.method(fs, 'accessSync', (...args: Parameters<typeof fs.accessSync>) => {
        if (args[0] === file) throw Object.assign(new Error(`EACCES ${file}`), { code: 'EACCES' })
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
    assert.equal(getDb().prepare("SELECT key FROM catalog_settings WHERE key LIKE 'play-grant:%'").all().length, before)
  })
}
