import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { WebError } from '@http/http'
import type { WebCatalogReader } from '@http/catalog'
import { gateCatalogUntilBound } from './catalogGate'

function stub(): WebCatalogReader {
  return {
    browse: () => ({
      items: [
        {
          id: 1,
          code: 'X',
          title: 'secret',
          cover: null,
          releaseDate: null,
          duration: null,
          rating: 0
        }
      ],
      total: 1,
      page: 1,
      pageSize: 36
    }),
    home: () => ({ discovery: [], recent: [] }),
    collections: () => ({ libraries: [{ id: 1, name: 'secret-lib', count: 1 }], playlists: [] }),
    detail: () => {
      throw new Error('unused')
    },
    image: async () => ({ body: Buffer.from('x'), mime: 'image/png' }),
    media: () => {
      throw new Error('unused')
    }
  }
}

describe('catalog bind gate', () => {
  it('refuses catalog reads until bound', async () => {
    let bound = false
    const catalog = gateCatalogUntilBound(stub(), () => bound)
    await assert.rejects(async () => catalog.collections(), (error: unknown) => {
      assert.ok(error instanceof WebError)
      assert.equal(error.status, 503)
      assert.match(error.message, /尚未认主/)
      return true
    })
    bound = true
    assert.equal((await catalog.collections()).libraries[0]?.name, 'secret-lib')
  })
})
