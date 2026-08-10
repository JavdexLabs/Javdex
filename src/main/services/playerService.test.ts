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
        throw new Error('No URL handler')
      }
    })

    assert.deepEqual(await service.playVideo(7), { ok: false, error: 'No URL handler' })
    assert.equal(calls, 1)
  })
})
