import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pendingInboxCount, pendingInboxBadgeValue } from './pendingInboxState'

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


it('keeps loading and failed inbox counts distinct from an empty inbox', () => {
  const empty = { libraries: [], pendingVideoCount: 0, actressConflictGroupCount: 0, isError: false }
  assert.equal(pendingInboxBadgeValue(empty), 0)
  assert.equal(pendingInboxBadgeValue({ ...empty, pendingVideoCount: undefined }), 'loading')
  assert.equal(pendingInboxBadgeValue({ ...empty, libraries: undefined }), 'loading')
  assert.equal(pendingInboxBadgeValue({ ...empty, isError: true }), 'error')
  assert.equal(pendingInboxBadgeValue({ ...empty, pendingVideoCount: 3 }), 3)
})
