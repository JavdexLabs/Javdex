import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { CatalogBackend } from '../application/catalogBackend'
import { createScrapeCatalogBinding } from './scrapeCatalogBinding'

describe('scrape catalog binding', () => {
  it('captures only a remote catalog backend per binding instance', () => {
    const local = createScrapeCatalogBinding({ mode: 'local' } as CatalogBackend)
    assert.equal(local.catalog, null)
    const remote = { mode: 'remote' } as CatalogBackend
    const first = createScrapeCatalogBinding(remote)
    const second = createScrapeCatalogBinding({ mode: 'remote' } as CatalogBackend)
    assert.equal(first.catalog, remote)
    assert.notEqual(first, second)
    assert.equal(local.catalog, null)
  })
})
