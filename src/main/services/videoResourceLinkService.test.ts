import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createVideoResourceLinkService } from './videoResourceLinkService'

describe('VideoResourceLinkService', () => {
  it('tests a direct link and returns Content-Length when available', async () => {
    const service = createVideoResourceLinkService({
      requestHead: async () => ({ ok: true, status: 206, sizeBytes: 10485760 })
    })

    assert.deepEqual(await service.check('https://cdn.example/movie.mp4'), {
      ok: true,
      status: 206,
      sizeBytes: 10485760
    })
  })

  it('returns a non-throwing failure without echoing a sensitive query', async () => {
    const service = createVideoResourceLinkService({
      requestHead: async () => {
        throw new Error('network failed for ?token=secret')
      }
    })

    const result = await service.check('https://cdn.example/movie.mp4?token=secret')
    assert.equal(result.ok, false)
    assert.equal(result.error?.includes('token=secret'), false)
  })

  it('routes checks through the hardened public HEAD transport', async () => {
    const requested: string[] = []
    const service = createVideoResourceLinkService({
      requestHead: async (url) => {
        requested.push(url)
        throw new Error('private redirect rejected')
      }
    })

    assert.deepEqual(await service.check('https://cdn.example/movie.mp4'), {
      ok: false,
      error: '无法连接到该链接，请检查网络或稍后重试'
    })
    assert.deepEqual(requested, ['https://cdn.example/movie.mp4'])
  })
})
