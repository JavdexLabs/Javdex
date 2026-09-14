import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { CatalogBackend } from '../application/catalogBackend'
import { bindScrapeCatalog, scrapeCatalog } from './scrapeCatalogBinding'

afterEach(() => {
  bindScrapeCatalog(null)
})

describe('scrape catalog binding', () => {
  it('binds only a remote catalog backend', () => {
    bindScrapeCatalog({ mode: 'local' } as CatalogBackend)
    assert.equal(scrapeCatalog(), null)
    const remote = { mode: 'remote' } as CatalogBackend
    bindScrapeCatalog(remote)
    assert.equal(scrapeCatalog(), remote)
    bindScrapeCatalog(null)
    assert.equal(scrapeCatalog(), null)
  })
})
