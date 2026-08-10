import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeLibraryScanError } from './libraryScanSummary'

describe('sanitizeLibraryScanError', () => {
  it('removes HTTP and Magnet query parameters from persisted and notified errors', () => {
    const result = sanitizeLibraryScanError(
      'failed https://example.test/watch?id=42&token=secret#private and magnet:?xt=urn:btih:SECRET&dn=Name'
    )

    assert.match(result, /https:\/\/example\.test\/watch/)
    assert.match(result, /magnet:/)
    assert.doesNotMatch(result, /token|secret|private|btih/i)
  })

  it('bounds arbitrary errors and never throws while formatting them', () => {
    const circular: { self?: unknown } = {}
    circular.self = circular
    assert.equal(sanitizeLibraryScanError(circular), '扫描失败')
    assert.equal(sanitizeLibraryScanError('x'.repeat(1000)).length, 500)
  })
})
