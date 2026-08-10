import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createVideoResourceLinkService } from './videoResourceLinkService'

describe('VideoResourceLinkService', () => {
  it('tests a direct link and returns Content-Length when available', async () => {
    const service = createVideoResourceLinkService({
      fetchImpl: async (_url, init) => {
        assert.equal(init?.method, 'HEAD')
        return new Response(null, {
          status: 206,
          headers: { 'content-length': '10485760' }
        })
      }
    })

    assert.deepEqual(await service.check('https://cdn.example/movie.mp4'), {
      ok: true,
      status: 206,
      sizeBytes: 10485760
    })
  })

  it('returns a non-throwing failure without echoing a sensitive query', async () => {
    const service = createVideoResourceLinkService({
      fetchImpl: async () => {
        throw new Error('network failed for ?token=secret')
      }
    })

    const result = await service.check('https://cdn.example/movie.mp4?token=secret')
    assert.equal(result.ok, false)
    assert.equal(result.error?.includes('token=secret'), false)
  })
})
