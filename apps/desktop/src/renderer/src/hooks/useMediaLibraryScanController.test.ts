import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { matchesMediaLibraryScanRun } from '../mediaLibraryScanState'

describe('media-library scan event scope', () => {
  it('accepts only the current library and, once known, the current run', () => {
    assert.equal(
      matchesMediaLibraryScanRun(2, null, { libraryId: 2, runId: 'run-a' }),
      true
    )
    assert.equal(
      matchesMediaLibraryScanRun(2, 'run-a', { libraryId: 2, runId: 'run-a' }),
      true
    )
    assert.equal(
      matchesMediaLibraryScanRun(2, 'run-a', { libraryId: 2, runId: 'run-b' }),
      false
    )
    assert.equal(
      matchesMediaLibraryScanRun(2, 'run-a', { libraryId: 3, runId: 'run-a' }),
      false
    )
  })
})
