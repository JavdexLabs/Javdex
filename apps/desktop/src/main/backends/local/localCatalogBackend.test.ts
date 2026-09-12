import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { insertTestVideoWithFile } from '@library/db/testVideoFixtures'
import { addMediaLibraryRoot } from '@library/db/mediaLibraryRepo'
import type { ScopedVideoDetail, ScopedVideoListResult } from '@shared/catalogTypes'
import { isStructuredError } from '@shared/protocol/errors'
import { createLocalCatalogBackend, createCatalogBackendForMode } from './localCatalogBackend'
import { createUnconfiguredRemoteBackend } from '../remote/unconfiguredRemoteBackend'
import { loadOrCreateLocalCatalogIdentity, localCatalogIdentityPath } from '../../desktop/localCatalogIdentity'

let tempRoot: string | null = null

function setupLibrary(): { root: string; libraryId: number; videoId: number } {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s02d-local-backend-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  const mediaRoot = path.join(tempRoot, 'media-root')
  fs.mkdirSync(mediaRoot)
  const videoPath = path.join(mediaRoot, 'S02D-001.mp4')
  fs.writeFileSync(videoPath, 'video')
  const db = initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  const root = addMediaLibraryRoot({
    libraryId: 1,
    expectedRevision: 1,
    root: { path: mediaRoot }
  })
  const inserted = insertTestVideoWithFile(db, {
    code: 'S02D-001',
    filePath: videoPath,
    title: 'Before',
    rootId: root.id
  })
  return { root: tempRoot, libraryId: 1, videoId: inserted.videoId }
}

afterEach(() => {
  closeDatabase()
  delete process.env.JAVDEX_TEST_USER_DATA
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('unconfigured remote backend', () => {
  it('does not open the local catalog database', async () => {
    const backend = createUnconfiguredRemoteBackend()
    assert.equal(backend.mode, 'remote')
    assert.equal(backend.session().state, 'disconnected')
    await assert.rejects(
      () => backend.queries.listVideos({ scope: { kind: 'all' } }),
      (error: unknown) => isStructuredError(error) && error.code === 'CONNECTION_UNAVAILABLE'
    )
    assert.throws(() => getDb(), /Database not initialised/)
  })
})

describe('LocalCatalogBackend', () => {
  it('lists and edits videos through the catalog port without a fake serverId', async () => {
    const { root, libraryId, videoId } = setupLibrary()
    const identity = loadOrCreateLocalCatalogIdentity(localCatalogIdentityPath(root))
    const backend = createLocalCatalogBackend({ identity, appVersion: '0.7.0' })
    assert.equal(backend.mode, 'local')
    assert.equal(backend.session().serverId, null)
    assert.equal(backend.session().schemaVersion, 16)
    assert.equal(backend.capabilities().editCatalog.allowed, true)
    assert.equal(backend.capabilities().playRemoteFile.allowed, false)

    const listed = (await backend.queries.listVideos({
      scope: { kind: 'library', libraryId }
    })) as ScopedVideoListResult
    assert.equal(listed.total >= 1, true)
    const detail = (await backend.queries.getVideo({
      scope: { kind: 'library', libraryId },
      videoId
    })) as ScopedVideoDetail | null
    assert.equal(detail?.title, 'Before')

    await backend.videos.edit(
      { videoId, fields: { title: 'After' } },
      { operationId: '00000000-0000-4000-8000-000000000001', expectedVersions: {} }
    )
    const updated = (await backend.queries.getVideo({
      scope: { kind: 'library', libraryId },
      videoId
    })) as ScopedVideoDetail | null
    assert.equal(updated?.title, 'After')

    await assert.rejects(
      () =>
        backend.nfo.plan({} as never, {
          operationId: '00000000-0000-4000-8000-000000000002',
          expectedVersions: {}
        }),
      (error: unknown) => isStructuredError(error) && error.code === 'UNSUPPORTED_CAPABILITY'
    )
  })

  it('selects the unconfigured remote factory without opening library.db', async () => {
    const backend = createCatalogBackendForMode('remote', {
      identity: { mode: 'local', catalogId: 'should-not-open' }
    })
    assert.equal(backend.mode, 'remote')
    await assert.rejects(
      () =>
        backend.videos.edit(
          { videoId: 1, fields: { title: 'nope' } },
          { operationId: '00000000-0000-4000-8000-000000000003', expectedVersions: {} }
        ),
      (error: unknown) => isStructuredError(error) && error.code === 'CONNECTION_UNAVAILABLE'
    )
    assert.throws(() => getDb(), /Database not initialised/)
  })
})
