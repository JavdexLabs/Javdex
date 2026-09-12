import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCacheAffinityId, setCacheAffinityDeviceKeyForTests } from './cacheAffinity'

afterEach(() => setCacheAffinityDeviceKeyForTests(null))

describe('cache affinity', () => {
  it('is stable, role-separated and does not expose source identifiers', () => {
    setCacheAffinityDeviceKeyForTests(Buffer.alloc(32, 7))
    const primary = createCacheAffinityId('secret-run-id', 'primary', 'secret-route')
    assert.equal(primary, createCacheAffinityId('secret-run-id', 'primary', 'secret-route'))
    assert.notEqual(primary, createCacheAffinityId('secret-run-id', 'verifier', 'secret-route'))
    assert.equal(primary.length, 47)
    assert.match(primary, /^jvx_[A-Za-z0-9_-]{43}$/)
    assert.doesNotMatch(primary, /secret/)
  })
})
