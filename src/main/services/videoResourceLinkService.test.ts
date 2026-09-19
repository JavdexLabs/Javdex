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
      error: '未能读取大小。站点可能拒绝探测请求，仍可导入。'
    })
    assert.deepEqual(requested, ['https://cdn.example/movie.mp4'])
  })

  it('reports HTTP failures without implying the resource cannot be imported', async () => {
    const service = createVideoResourceLinkService({
      requestHead: async () => ({ ok: false, status: 403, sizeBytes: null })
    })

    assert.deepEqual(await service.check('https://cdn.example/movie.mp4'), {
      ok: false,
      status: 403,
      sizeBytes: null,
      error: '探测返回 HTTP 403；不代表无法导入。'
    })
  })
})
