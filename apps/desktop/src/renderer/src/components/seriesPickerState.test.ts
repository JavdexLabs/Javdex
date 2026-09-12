import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  selectedSeriesAssignment,
  seriesOptionDescription,
  typedSeriesAssignment
} from './seriesPickerState'

const sameName = [
  {
    id: 11,
    mainName: 'Collection',
    aliases: ['First Edition'],
    ownerOrganization: { id: 2, mainName: 'Studio A' },
    videoCount: 3
  },
  {
    id: 12,
    mainName: 'Collection',
    aliases: [],
    ownerOrganization: { id: 4, mainName: 'Studio B' },
    videoCount: 1
  }
]

describe('series picker state', () => {
  it('keeps typed creation separate from selecting an existing stable identity', () => {
    assert.deepEqual(typedSeriesAssignment(' New Series '), { createName: 'New Series' })
    assert.deepEqual(selectedSeriesAssignment(sameName[0]), { seriesId: 11 })
    assert.equal(typedSeriesAssignment('  '), null)
  })

  it('always distinguishes same-name candidates by stable id and owner scope', () => {
    assert.match(seriesOptionDescription(sameName[0]), /#11/)
    assert.match(seriesOptionDescription(sameName[0]), /Studio A/)
    assert.match(seriesOptionDescription(sameName[0]), /First Edition/)
    assert.match(seriesOptionDescription(sameName[1]), /#12/)
    assert.match(seriesOptionDescription(sameName[1]), /Studio B/)
  })
})
