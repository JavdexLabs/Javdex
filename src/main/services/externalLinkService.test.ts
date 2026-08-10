import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeExternalHttpUrl } from './externalLinkService'

describe('external link service', () => {
  it('accepts only bounded HTTP and HTTPS links', () => {
    assert.equal(normalizeExternalHttpUrl('https://example.com/path'), 'https://example.com/path')
    assert.equal(normalizeExternalHttpUrl('http://example.com/path'), 'http://example.com/path')
    assert.equal(normalizeExternalHttpUrl('file:///tmp/private'), null)
    assert.equal(normalizeExternalHttpUrl('javascript:alert(1)'), null)
    assert.equal(normalizeExternalHttpUrl('not a url'), null)
  })
})
