import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isBelowMinImportDuration, resolveMinScanImportDurationSeconds, resolveVideoDisplayDurationSeconds, shouldProbeVideoFileDuration, shouldRefreshVideoFileDuration } from './videoDuration'

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

  it('prefers scraped duration over primary file duration', () => {
    assert.equal(
      resolveVideoDisplayDurationSeconds({
        duration_seconds: 3661,
        file_duration_seconds: 900
      }),
      3661
    )
  })

  it('uses primary file duration when scraped duration is missing', () => {
    assert.equal(
      resolveVideoDisplayDurationSeconds({
        duration_seconds: null,
        file_duration_seconds: 900
      }),
      900
    )
  })

  it('returns null when both durations are missing', () => {
    assert.equal(
      resolveVideoDisplayDurationSeconds({
        duration_seconds: null,
        file_duration_seconds: null
      }),
      null
    )
  })

  it('only refreshes stored file duration when probe value changed', () => {
    assert.equal(shouldRefreshVideoFileDuration(3600, 3600), false)
    assert.equal(shouldRefreshVideoFileDuration(3600, 3700), true)
    assert.equal(shouldRefreshVideoFileDuration(null, 3600), true)
    assert.equal(shouldRefreshVideoFileDuration(3600, null), false)
    assert.equal(shouldRefreshVideoFileDuration(3600, 0), false)
  })

  it('only probes when duration is missing or file fingerprint changed', () => {
    const stored = {
      file_duration_seconds: 3600,
      file_size: 1000,
      file_mtime_ms: 123
    }
    const fingerprint = { file_size: 1000, file_mtime_ms: 123 }
    assert.equal(shouldProbeVideoFileDuration(stored, fingerprint), false)
    assert.equal(
      shouldProbeVideoFileDuration(
        { ...stored, file_duration_seconds: null },
        fingerprint
      ),
      true
    )
    assert.equal(
      shouldProbeVideoFileDuration(stored, { file_size: 1001, file_mtime_ms: 123 }),
      true
    )
    assert.equal(
      shouldProbeVideoFileDuration(stored, { file_size: 1000, file_mtime_ms: 456 }),
      true
    )
    assert.equal(
      shouldProbeVideoFileDuration(
        { ...stored, file_mtime_ms: null },
        fingerprint
      ),
      false
    )
    assert.equal(
      shouldProbeVideoFileDuration(
        { ...stored, file_mtime_ms: null },
        { file_size: 2000, file_mtime_ms: 123 }
      ),
      true
    )
  })
})
