import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resourceLocatorRevision } from './catalogPlay'

describe('catalogPlay locator revision', () => {
  it('changes when the resource locator or fingerprint changes', () => {
    const base = {
      kind: 'local' as const,
      locator: '/media/ABC-001.mp4',
      source_identity: 'local:/media/ABC-001.mp4',
      root_id: 1,
      size_bytes: 16,
      file_mtime_ms: 1000
    }
    const first = resourceLocatorRevision(base)
    assert.equal(first.length, 64)
    assert.equal(resourceLocatorRevision(base), first)
    assert.notEqual(resourceLocatorRevision({ ...base, locator: '/media/ABC-002.mp4' }), first)
    assert.notEqual(resourceLocatorRevision({ ...base, file_mtime_ms: 2000 }), first)
  })
})
