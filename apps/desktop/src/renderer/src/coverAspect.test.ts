import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  POSTER_LIBRARY_BADGE_ROW_HEIGHT,
  POSTER_META_HEIGHT,
  computePosterGridRowHeight
} from './coverAspect'

describe('poster grid row height', () => {
  it('reserves the complete membership strip without changing ordinary library rows', () => {
    const posterHeight = 200
    const gap = 12

    assert.equal(
      computePosterGridRowHeight(posterHeight, { gap }),
      posterHeight + POSTER_META_HEIGHT + gap
    )
    assert.equal(
      computePosterGridRowHeight(posterHeight, { gap, showLibraryBadges: true }),
      posterHeight + POSTER_META_HEIGHT + POSTER_LIBRARY_BADGE_ROW_HEIGHT + gap
    )
  })
})
