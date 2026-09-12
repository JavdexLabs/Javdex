import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolveMediaAssetPath, toStoredAssetPath, serveMediaAssetRequest } from './mediaProtocol'
import { AssetReadQueueFullError, AssetReadTooLargeError, AssetPixelLimitError } from './mediaAssetStore'

describe('mediaProtocol', () => {
  it('forwards a finite variant and rejects invalid size without reading', async () => {
    let calls = 0
    const reader = { rootPath: () => path.resolve('tmp-assets'), readForServeAsync: async (_rel: string, _signal?: AbortSignal, size?: number) => {
      calls++
      assert.equal(size, 640)
      return { body: Buffer.from('thumbnail'), mime: 'image/webp' }
    } }
    const response = await serveMediaAssetRequest(new Request('media://covers/test.jpg?size=640'), reader)
    assert.equal(response.headers.get('Content-Type'), 'image/webp')
    for (const method of ['GET', 'HEAD']) {
      const bad = await serveMediaAssetRequest(new Request('media://covers/test.jpg?size=999999', { method }), reader)
      assert.equal(bad.status, 400)
      if (method === 'HEAD') assert.equal(await bad.text(), '')
    }
    assert.equal(calls, 1)
  })
  it('returns 413 for oversized images with an empty HEAD body', async () => {
    for (const Failure of [AssetReadTooLargeError, AssetPixelLimitError]) for (const method of ['GET', 'HEAD']) {
      const response = await serveMediaAssetRequest(new Request('media://covers/large.jpg', { method }), {
        rootPath: () => path.resolve('tmp-assets'),
        readForServeAsync: async () => { throw new Failure() }
      })
      assert.equal(response.status, 413)
      assert.equal(await response.text(), method === 'HEAD' ? '' : 'Image Too Large')
    }
  })
  it('awaits the image reader and forwards cancellation while serving GET and HEAD', async () => {
    const request = new Request('media://covers/test.jpg')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let finished = false
    const reader = {
      rootPath: () => path.resolve('tmp-assets'),
      readForServeAsync: async (rel: string, signal?: AbortSignal) => {
        assert.equal(rel, 'covers/test.jpg')
        assert.equal(signal, request.signal)
        await gate
        return { body: Buffer.from('image'), mime: 'image/jpeg' }
      }
    }
    const response = serveMediaAssetRequest(request, reader).then((value) => { finished = true; return value })
    await Promise.resolve()
    assert.equal(finished, false)
    release()
    const get = await response
    assert.equal(await get.text(), 'image')
    assert.equal(get.headers.get('Content-Type'), 'image/jpeg')
    const head = await serveMediaAssetRequest(new Request(request.url, { method: 'HEAD' }), {
      ...reader, readForServeAsync: async () => ({ body: Buffer.from('image'), mime: 'image/jpeg' })
    })
    assert.equal(await head.text(), '')
    assert.equal(head.headers.get('Content-Length'), '5')
  })

  it('skips reads for preflight and forbidden paths, and distinguishes busy from missing', async () => {
    let reads = 0
    let busy = true
    const reader = {
      rootPath: () => path.resolve('tmp-assets'),
      readForServeAsync: async () => {
        reads++
        if (busy) throw new AssetReadQueueFullError()
        throw Error('missing')
      }
    }
    assert.equal((await serveMediaAssetRequest(new Request('media://covers/a.jpg', { method: 'OPTIONS' }), reader)).status, 204)
    assert.equal((await serveMediaAssetRequest(new Request('media://covers/%2E%2E%2F%2E%2E%2Fsecret'), reader)).status, 403)
    assert.equal(reads, 0)
    assert.equal((await serveMediaAssetRequest(new Request('media://covers/a.jpg'), reader)).status, 503)
    busy = false
    assert.equal((await serveMediaAssetRequest(new Request('media://covers/a.jpg'), reader)).status, 404)
    for (const status of [403, 404, 503]) {
      busy = status === 503
      const url = status === 403 ? 'media://covers/%2E%2E%2F%2E%2E%2Fsecret' : 'media://covers/a.jpg'
      const response = await serveMediaAssetRequest(new Request(url, { method: 'HEAD' }), reader)
      assert.equal(response.status, status)
      assert.equal(await response.text(), '')
    }
  })

  it('resolves media URLs under the asset root', () => {
    const root = path.resolve('tmp-assets')
    const abs = resolveMediaAssetPath('media://covers/IPX-535.jpg', root)

    assert.equal(abs, path.join(root, 'covers', 'IPX-535.jpg'))
    assert.equal(toStoredAssetPath(abs!, root), 'covers/IPX-535.jpg')
  })

  it('rejects path traversal outside the asset root', () => {
    const root = path.resolve('tmp-assets')
    assert.equal(resolveMediaAssetPath('media://covers/../avatars/a.jpg', root), null)
    assert.equal(resolveMediaAssetPath('media://covers/%2E%2E/%2E%2E/secret.txt', root), null)
  })
})
