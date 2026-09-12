import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { VideoResource } from '@shared/videoTypes'
import { closeDatabase, initDatabaseAtPath } from '../db/database'
import { createPlayerService } from './playerService'

function resource(overrides: Partial<VideoResource> = {}): VideoResource {
  return {
    id: 3,
    library_id: 1,
    video_id: 7,
    root_id: null,
    kind: 'direct',
    locator: 'https://cdn.example/movie.mp4?token=secret',
    resource_key: 'http:https://cdn.example/movie.mp4?token=secret',
    source_identity: null,
    strm_source_path: null,
    size_bytes: null,
    duration_seconds: null,
    file_mtime_ms: null,
    display_name: null,
    is_primary: 1,
    add_time: '2026-08-10T00:00:00.000Z',
    ...overrides
  }
}

describe('PlayerService', () => {
  it('opens and reveals a local resource through system file operations', async () => {
    const opened: string[] = []
    const revealed: string[] = []
    const local = resource({ kind: 'local', locator: '/library/ABC-123.mp4' })
    const service = createPlayerService({
      getMediaLibrary: () => ({ status: 'active' }) as never,
      getVideoResourceInLibrary: () => local,
      fileExists: () => true,
      openPath: async (filePath) => {
        opened.push(filePath)
        return ''
      },
      showItemInFolder: (filePath) => revealed.push(filePath)
    })

    assert.deepEqual(await service.openResource(local.library_id, local.id), { ok: true })
    assert.deepEqual(service.revealResource(local.library_id, local.id), { ok: true })
    assert.deepEqual(opened, [local.locator])
    assert.deepEqual(revealed, [local.locator])
  })

  it('opens a STRM target externally but reveals its local source file', async () => {
    const opened: string[] = []
    const revealed: string[] = []
    const strm = resource({
      kind: 'direct',
      locator: 'https://cdn.example/movie.mp4?token=secret',
      strm_source_path: '/library/ABC-001.strm'
    })
    const service = createPlayerService({
      getMediaLibrary: () => ({ status: 'active' }) as never,
      getVideoResourceInLibrary: () => strm,
      fileExists: (filePath) => filePath === strm.strm_source_path,
      openExternal: async (target) => {
        opened.push(target)
      },
      showItemInFolder: (filePath) => revealed.push(filePath)
    })

    assert.deepEqual(await service.openResource(strm.library_id, strm.id), { ok: true })
    assert.deepEqual(service.revealResource(strm.library_id, strm.id), { ok: true })
    assert.deepEqual(opened, [strm.locator])
    assert.deepEqual(revealed, [strm.strm_source_path])
  })

  it('opens the primary direct resource with the system URL handler', async () => {
    const opened: string[] = []
    const service = createPlayerService({
      getMediaLibrary: () => ({ status: 'active' }) as never,
      getVideoById: () => ({ id: 7, code: 'ABC-123' }) as never,
      getPrimaryVideoResource: () => resource(),
      openExternal: async (url) => {
        opened.push(url)
      }
    })

    assert.deepEqual(await service.playVideo(1, 7), { ok: true })
    assert.deepEqual(opened, ['https://cdn.example/movie.mp4?token=secret'])
  })

  it('reports a system open failure and does not try another resource', async () => {
    let calls = 0
    const service = createPlayerService({
      getMediaLibrary: () => ({ status: 'active' }) as never,
      getVideoById: () => ({ id: 7, code: 'ABC-123' }) as never,
      getPrimaryVideoResource: () => resource(),
      openExternal: async () => {
        calls += 1
        throw new Error('No URL handler for https://cdn.example/movie.mp4?token=secret')
      }
    })

    assert.deepEqual(await service.playVideo(1, 7), {
      ok: false,
      error: '系统无法打开该资源'
    })
    assert.equal(calls, 1)
  })

  it('hands Magnet resources to the registered system protocol handler', async () => {
    const opened: string[] = []
    const service = createPlayerService({
      getMediaLibrary: () => ({ status: 'active' }) as never,
      getVideoResourceInLibrary: () =>
        resource({ kind: 'magnet', locator: 'magnet:?xt=urn:btih:abcdef1234567890' }),
      openExternal: async (url) => {
        opened.push(url)
      }
    })

    assert.deepEqual(await service.openResource(1, 3), { ok: true })
    assert.deepEqual(opened, ['magnet:?xt=urn:btih:abcdef1234567890'])
  })

  it('rejects every playback and reveal entry point before reading an archived or missing library', async () => {
    let resourceReads = 0
    const service = createPlayerService({
      getMediaLibrary: (libraryId) =>
        libraryId === 1 ? ({ status: 'archived' } as never) : null,
      getVideoById: () => {
        resourceReads += 1
        return ({ id: 7, code: 'ABC-123' }) as never
      },
      getPrimaryVideoResource: () => {
        resourceReads += 1
        return resource()
      },
      getVideoResourceInLibrary: () => {
        resourceReads += 1
        return resource()
      }
    })

    const archived = {
      ok: false,
      error: '已归档媒体库必须恢复后才能播放或定位资源'
    }
    assert.deepEqual(await service.playVideo(1, 7), archived)
    assert.deepEqual(await service.openResource(1, 3), archived)
    assert.deepEqual(service.revealVideo(1, 7), archived)
    assert.deepEqual(service.revealResource(1, 3), archived)
    assert.deepEqual(await service.playVideo(99, 7), {
      ok: false,
      error: '媒体库不存在'
    })
    assert.equal(resourceReads, 0)
  })

  it('opens and reveals only resources that belong to the selected library', async () => {
    closeDatabase()
    const database = initDatabaseAtPath(':memory:')
    const opened: string[] = []
    const revealed: string[] = []
    try {
      const secondLibraryId = Number(
        database
          .prepare(
            "INSERT INTO media_libraries (name) VALUES ('Second library')"
          )
          .run().lastInsertRowid
      )
      const videoId = Number(
        database.prepare("INSERT INTO videos (code) VALUES ('SCOPE-001')").run()
          .lastInsertRowid
      )
      const insertMembership = database.prepare(
        `INSERT INTO library_video_memberships (
           library_id, video_id, added_via, discovery_key
         ) VALUES (?, ?, 'manual', ?)`
      )
      insertMembership.run(1, videoId, 101)
      insertMembership.run(secondLibraryId, videoId, 102)
      const insertResource = database.prepare(
        `INSERT INTO video_resources (
           library_id, video_id, kind, locator, resource_key,
           source_identity, is_primary
         ) VALUES (?, ?, 'local', ?, ?, ?, 1)`
      )
      const firstLocator = '/first/SCOPE-001.mp4'
      const secondLocator = '/second/SCOPE-001.mp4'
      insertResource.run(
        1,
        videoId,
        firstLocator,
        `local:${firstLocator}`,
        `local:${firstLocator}`
      )
      const secondResourceId = Number(
        insertResource.run(
          secondLibraryId,
          videoId,
          secondLocator,
          `local:${secondLocator}`,
          `local:${secondLocator}`
        ).lastInsertRowid
      )
      const service = createPlayerService({
        fileExists: () => true,
        openPath: async (filePath) => {
          opened.push(filePath)
          return ''
        },
        showItemInFolder: (filePath) => revealed.push(filePath)
      })

      assert.deepEqual(await service.playVideo(1, videoId), { ok: true })
      assert.deepEqual(await service.playVideo(secondLibraryId, videoId), {
        ok: true
      })
      assert.deepEqual(await service.openResource(1, secondResourceId), {
        ok: false,
        error: '资源记录不存在'
      })
      assert.deepEqual(
        await service.openResource(secondLibraryId, secondResourceId),
        {
          ok: true
        }
      )
      assert.deepEqual(service.revealVideo(1, videoId), { ok: true })
      assert.deepEqual(service.revealVideo(secondLibraryId, videoId), {
        ok: true
      })
      assert.deepEqual(service.revealResource(1, secondResourceId), {
        ok: false,
        error: '该资源不是本地文件'
      })
      assert.deepEqual(
        service.revealResource(secondLibraryId, secondResourceId),
        { ok: true }
      )
      assert.deepEqual(opened, [firstLocator, secondLocator, secondLocator])
      assert.deepEqual(revealed, [firstLocator, secondLocator, secondLocator])
    } finally {
      closeDatabase()
    }
  })
})
