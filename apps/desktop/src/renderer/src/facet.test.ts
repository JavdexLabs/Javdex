import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { supportsFacetDetail } from './facet'

describe('facet route contracts', () => {
  it('only permits each entity detail under its matching facet', () => {
    assert.equal(supportsFacetDetail('maker', 'organization'), true)
    assert.equal(supportsFacetDetail('publisher', 'organization'), true)
    assert.equal(supportsFacetDetail('director', 'director'), true)
    assert.equal(supportsFacetDetail('series', 'series'), true)

    assert.equal(supportsFacetDetail('maker', 'director'), false)
    assert.equal(supportsFacetDetail('director', 'organization'), false)
    assert.equal(supportsFacetDetail('series', 'director'), false)
    assert.equal(supportsFacetDetail(undefined, 'series'), false)
  })
})
