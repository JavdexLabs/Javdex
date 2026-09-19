import { afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { addMediaLibraryRoot } from '@library/db/mediaLibraryRepo'
import { listVideoResources } from '@library/db/videoRepo'
import { ensureCatalogIdentity } from '@library/catalog/catalogIdentity'
import { catalogVideoCommands } from '@library/catalog/catalogVideoCommands'
import { readVideoAggregateVersion } from '@library/catalog/catalogVideoVersion'
import { assertFileMaintenanceVersions, readFileMaintenanceVersions } from '@library/catalog/catalogFileMaintenance'
import { createLibraryLocalNfoScanService } from '@library/nfo/libraryLocalNfoScanService'
import { scanFolders } from './scanner'

const previousUserData = process.env.JAVDEX_TEST_USER_DATA
let directory: string | undefined
afterEach(() => {
  closeDatabase()
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
  directory = undefined
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
})

function fixture() {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-scan-versions-')))
  process.env.JAVDEX_TEST_USER_DATA = directory
  initDatabaseAtPath(path.join(directory, 'catalog.db'))
  ensureCatalogIdentity()
  const mount = path.join(directory, 'media')
  fs.mkdirSync(mount)
  const root = addMediaLibraryRoot({ libraryId: 1, expectedRevision: 1, root: { path: mount } })
  const scan = () => scanFolders({ libraryId: 1, runId: randomUUID(), roots: [root] }, undefined, {
    autoMergeSameCodeResources: true,
    autoImportLocalNfo: true,
    minImportDurationSeconds: null,
    localNfoService: createLibraryLocalNfoScanService()
  })
  return { mount, root, scan }
}

it('rejects stale file versions after a scan refreshes a STRM target without invalidating metadata edits', async () => {
  const { mount, root, scan } = fixture()
  const source = path.join(mount, 'VER-001.strm')
  fs.writeFileSync(source, 'https://example.test/first.mp4')
  assert.equal((await scan()).imported, 1)
  const video = getDb().prepare("SELECT id FROM videos WHERE code='VER-001'").get() as { id: number }
  const resource = listVideoResources(1, video.id)[0]
  const input = { libraryId: 1, resourceId: resource.id, location: { rootId: root.id, relativePath: 'VER-001.strm' } }
  const before = readFileMaintenanceVersions(input)
  const videoVersion = readVideoAggregateVersion(video.id)!
  await scan()
  assert.deepEqual(readFileMaintenanceVersions(input), before)
  fs.writeFileSync(source, 'https://example.test/second.mp4')
  assert.equal((await scan()).refreshed, 1)
  assert.equal(listVideoResources(1, video.id)[0].locator, 'https://example.test/second.mp4')
  assert.throws(() => assertFileMaintenanceVersions(input, before, randomUUID()),
    (error: unknown) => (error as { code?: string }).code === 'VERSION_CONFLICT')
  assertFileMaintenanceVersions(input, readFileMaintenanceVersions(input), randomUUID())
  assert.deepEqual(readVideoAggregateVersion(video.id), videoVersion)
  assert.equal(catalogVideoCommands.edit({ videoId: video.id, fields: { title: 'User title' } }, {
    operationId: randomUUID(), writerEpoch: 0, expectedVersions: { V: videoVersion }
  }).outcome, 'applied')
})

it('server NFO identity inspection does not import metadata or invalidate an open edit', async () => {
  const { mount, scan } = fixture()
  const videoId = Number(getDb().prepare("INSERT INTO videos(code) VALUES ('VER-002')").run().lastInsertRowid)
  const before = readVideoAggregateVersion(videoId)!
  fs.writeFileSync(path.join(mount, 'VER-002.strm'), 'https://example.test/video.mp4')
  fs.writeFileSync(path.join(mount, 'VER-002.nfo'), '<movie><num>VER-002</num><title>NFO title</title></movie>')
  assert.equal((await scan()).imported, 1)
  const video = getDb().prepare('SELECT title, scraped_status FROM videos WHERE id=?').get(videoId)
  assert.deepEqual(video, { title: null, scraped_status: 0 })
  assert.deepEqual(readVideoAggregateVersion(videoId), before)
  assert.equal(catalogVideoCommands.edit({ videoId, fields: { title: 'User title' } }, {
    operationId: randomUUID(), writerEpoch: 0, expectedVersions: { V: before }
  }).outcome, 'applied')
})
