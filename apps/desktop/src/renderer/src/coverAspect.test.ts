import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  POSTER_LIBRARY_BADGE_ROW_HEIGHT,
  POSTER_META_HEIGHT,
  computePosterGridLayout,
  computePosterGridRowHeight,
  getPosterMinColWidth
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

  it('scales column count and minimum width across the four cover size presets', () => {
    const sm = computePosterGridLayout(1000, 'portrait', 12, 'sm')
    const md = computePosterGridLayout(1000, 'portrait', 12, 'md')
    const lg = computePosterGridLayout(1000, 'portrait', 12, 'lg')
    const xl = computePosterGridLayout(1000, 'portrait', 12, 'xl')

    assert.ok(sm.columnCount >= md.columnCount)
    assert.ok(md.columnCount >= lg.columnCount)
    assert.ok(lg.columnCount >= xl.columnCount)
    assert.ok(getPosterMinColWidth('portrait', 'sm', 'detail') < getPosterMinColWidth('portrait', 'xl', 'detail'))
    assert.ok(getPosterMinColWidth('landscape', 'sm', 'main') < getPosterMinColWidth('landscape', 'xl', 'main'))
  })
})
