import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { VideoResource } from '@shared/videoTypes'
import { createPlayerService } from './playerService'

function resource(overrides: Partial<VideoResource> = {}): VideoResource {
  return {
    id: 3,
    video_id: 7,
    kind: 'direct',
    locator: 'https://cdn.example/movie.mp4?token=secret',
    resource_key: 'http:https://cdn.example/movie.mp4?token=secret',
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
      getVideoResourceById: () => local,
      fileExists: () => true,
      openPath: async (filePath) => {
        opened.push(filePath)
        return ''
      },
      showItemInFolder: (filePath) => revealed.push(filePath)
    })

    assert.deepEqual(await service.openResource(local.id), { ok: true })
    assert.deepEqual(service.revealResource(local.id), { ok: true })
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
      getVideoResourceById: () => strm,
      fileExists: (filePath) => filePath === strm.strm_source_path,
      openExternal: async (target) => {
        opened.push(target)
      },
      showItemInFolder: (filePath) => revealed.push(filePath)
    })

    assert.deepEqual(await service.openResource(strm.id), { ok: true })
    assert.deepEqual(service.revealResource(strm.id), { ok: true })
    assert.deepEqual(opened, [strm.locator])
    assert.deepEqual(revealed, [strm.strm_source_path])
  })

  it('opens the primary direct resource with the system URL handler', async () => {
    const opened: string[] = []
    const service = createPlayerService({
      getVideoById: () => ({ id: 7, code: 'ABC-123' }) as never,
      getPrimaryVideoResource: () => resource(),
      openExternal: async (url) => {
        opened.push(url)
      }
    })

    assert.deepEqual(await service.playVideo(7), { ok: true })
    assert.deepEqual(opened, ['https://cdn.example/movie.mp4?token=secret'])
  })

  it('reports a system open failure and does not try another resource', async () => {
    let calls = 0
    const service = createPlayerService({
      getVideoById: () => ({ id: 7, code: 'ABC-123' }) as never,
      getPrimaryVideoResource: () => resource(),
      openExternal: async () => {
        calls += 1
        throw new Error('No URL handler for https://cdn.example/movie.mp4?token=secret')
      }
    })

    assert.deepEqual(await service.playVideo(7), {
      ok: false,
      error: '系统无法打开该资源'
    })
    assert.equal(calls, 1)
  })

  it('hands Magnet resources to the registered system protocol handler', async () => {
    const opened: string[] = []
    const service = createPlayerService({
      getVideoResourceById: () =>
        resource({ kind: 'magnet', locator: 'magnet:?xt=urn:btih:abcdef1234567890' }),
      openExternal: async (url) => {
        opened.push(url)
      }
    })

    assert.deepEqual(await service.openResource(3), { ok: true })
    assert.deepEqual(opened, ['magnet:?xt=urn:btih:abcdef1234567890'])
  })
})
