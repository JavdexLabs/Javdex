import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pendingInboxCount } from './pendingInboxState'

describe('pending inbox state', () => {
  it('sums the aggregate media-library projection without per-library item reads', () => {
    assert.equal(
      pendingInboxCount({
        libraries: [
          { pendingScanGroupCount: 2 },
          { pendingScanGroupCount: 0 },
          { pendingScanGroupCount: 4 }
        ],
        pendingVideoCount: 3,
        actressConflictGroupCount: 1
      }),
      10
    )
  })
})
