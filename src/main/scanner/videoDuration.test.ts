import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isBelowMinImportDuration, resolveMinScanImportDurationSeconds } from './videoDuration'

describe('videoDuration', () => {
  it('resolves configured minutes to seconds', () => {
    assert.equal(resolveMinScanImportDurationSeconds(30), 1800)
    assert.equal(resolveMinScanImportDurationSeconds(0), null)
    assert.equal(resolveMinScanImportDurationSeconds(-1), null)
  })

  it('treats unknown duration as not below minimum', () => {
    assert.equal(isBelowMinImportDuration(null, 1800), false)
  })

  it('flags durations shorter than threshold', () => {
    assert.equal(isBelowMinImportDuration(29 * 60, 30 * 60), true)
    assert.equal(isBelowMinImportDuration(30 * 60, 30 * 60), false)
    assert.equal(isBelowMinImportDuration(31 * 60, 30 * 60), false)
  })
})
