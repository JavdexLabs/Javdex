import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLOSED_CLASSIFICATION_PICKER,
  reduceClassificationPicker,
  visibleClassificationPicker
} from './classificationPickerState'

describe('classification picker state', () => {
  it('stays closed until the user asks for candidates', () => {
    assert.deepEqual(visibleClassificationPicker(CLOSED_CLASSIFICATION_PICKER, 'Collection', 3), {
      open: false,
      activeIndex: -1
    })
    const typed = reduceClassificationPicker(CLOSED_CLASSIFICATION_PICKER, { type: 'query' }, 3)
    assert.deepEqual(visibleClassificationPicker(typed, 'Collection', 3), {
      open: true,
      activeIndex: -1
    })
  })

  it('hides candidates when the query or the result set is empty', () => {
    const typed = reduceClassificationPicker(CLOSED_CLASSIFICATION_PICKER, { type: 'query' }, 0)
    assert.equal(visibleClassificationPicker(typed, '   ', 3).open, false)
    assert.equal(visibleClassificationPicker(typed, 'Collection', 0).open, false)
  })

  it('opens on arrow navigation and wraps around the candidate list', () => {
    const down = reduceClassificationPicker(CLOSED_CLASSIFICATION_PICKER, { type: 'move', delta: 1 }, 3)
    assert.deepEqual(down, { open: true, activeIndex: 0 })
    const up = reduceClassificationPicker(CLOSED_CLASSIFICATION_PICKER, { type: 'move', delta: -1 }, 3)
    assert.deepEqual(up, { open: true, activeIndex: 2 })
    assert.equal(reduceClassificationPicker(down, { type: 'move', delta: -1 }, 3).activeIndex, 2)
    assert.equal(
      reduceClassificationPicker({ open: true, activeIndex: 2 }, { type: 'move', delta: 1 }, 3)
        .activeIndex,
      0
    )
  })

  it('never navigates into an empty candidate list', () => {
    assert.deepEqual(
      reduceClassificationPicker(CLOSED_CLASSIFICATION_PICKER, { type: 'move', delta: 1 }, 0),
      CLOSED_CLASSIFICATION_PICKER
    )
  })

  it('drops the active candidate when typing or when the result set shrinks', () => {
    const active = { open: true, activeIndex: 2 }
    assert.deepEqual(reduceClassificationPicker(active, { type: 'query' }, 3), {
      open: true,
      activeIndex: -1
    })
    assert.deepEqual(visibleClassificationPicker(active, 'Collection', 2), {
      open: true,
      activeIndex: -1
    })
  })

  it('closes on dismiss', () => {
    assert.deepEqual(
      reduceClassificationPicker({ open: true, activeIndex: 1 }, { type: 'dismiss' }, 3),
      CLOSED_CLASSIFICATION_PICKER
    )
  })
})
