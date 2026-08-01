import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { BatchProgress } from '@shared/types'
import { isBatchScrapeActive } from './batchScrapeActivity'

function batch(status: BatchProgress['status']): BatchProgress {
  return {
    total: 7,
    current: 7,
    success: 4,
    pending: 0,
    failed: 3,
    currentCode: null,
    status,
    logs: []
  }
}

describe('isBatchScrapeActive', () => {
  it('treats only running and paused batches as active', () => {
    assert.equal(isBatchScrapeActive(null), false)
    assert.equal(isBatchScrapeActive(batch('idle')), false)
    assert.equal(isBatchScrapeActive(batch('done')), false)
    assert.equal(isBatchScrapeActive(batch('cancelled')), false)
    assert.equal(isBatchScrapeActive(batch('running')), true)
    assert.equal(isBatchScrapeActive(batch('paused')), true)
  })
})
