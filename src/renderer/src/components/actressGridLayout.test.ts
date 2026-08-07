import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { actressGridSlotCount, computeActressGridLayout } from './actressGridLayout'

describe('actress virtual grid layout', () => {
  it('derives responsive columns without shrinking cards below their minimum width', () => {
    const layout = computeActressGridLayout(996)

    assert.equal(layout.columnCount, 7)
    assert.ok(layout.cardWidth >= 132)
    assert.equal(layout.rowHeight, layout.cardWidth + 12)
  })

  it('places load state on a dedicated row after an incomplete item row', () => {
    assert.deepEqual(actressGridSlotCount(10, 4, true), {
      statusRowStart: 12,
      renderedCount: 16
    })
    assert.deepEqual(actressGridSlotCount(10, 4, false), {
      statusRowStart: 12,
      renderedCount: 10
    })
  })
})
