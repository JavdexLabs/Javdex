import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildClassificationMergeCommand,
  reconcileClassificationMergeSource
} from './classificationMergeState'

interface Candidate {
  id: number
  mainName: string
}

function candidate(id: number, mainName: string): Candidate {
  return { id, mainName }
}

describe('classification merge interaction state', () => {
  it('keeps the selected source identity when refreshed candidates reorder', () => {
    const selected = candidate(20, 'Source')
    const refreshed = [candidate(30, 'Other'), candidate(20, 'Source refreshed')]

    const reconciled = reconcileClassificationMergeSource(selected, refreshed)

    assert.equal(reconciled?.id, 20)
    assert.equal(reconciled?.mainName, 'Source refreshed')
    assert.deepEqual(buildClassificationMergeCommand(10, reconciled?.id ?? null), {
      targetId: 10,
      sourceId: 20
    })
  })

  it('keeps a selected source through a narrower search and rejects invalid commands', () => {
    const selected = candidate(20, 'Source')

    assert.equal(
      reconcileClassificationMergeSource(selected, [candidate(30, 'Other')]),
      selected
    )
    assert.equal(buildClassificationMergeCommand(10, null), null)
    assert.equal(buildClassificationMergeCommand(10, 10), null)
    assert.equal(buildClassificationMergeCommand(0, 20), null)
  })
})
