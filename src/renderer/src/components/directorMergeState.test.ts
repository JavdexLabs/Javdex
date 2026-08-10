import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { DirectorOption } from '@shared/classificationTypes'
import {
  buildDirectorMergeInput,
  reconcileDirectorMergeSource
} from './directorMergeState'

function candidate(id: number, mainName: string): DirectorOption {
  return {
    id,
    mainName,
    aliases: [],
    countryRegion: null,
    birthDate: null,
    careerStartYear: null,
    careerEndYear: null,
    videoCount: 0
  }
}

describe('director merge interaction state', () => {
  it('keeps the selected source identity when refreshed candidates reorder', () => {
    const selected = candidate(20, 'Source')
    const refreshed = [candidate(30, 'Other'), candidate(20, 'Source refreshed')]

    const reconciled = reconcileDirectorMergeSource(selected, refreshed)

    assert.equal(reconciled?.id, 20)
    assert.equal(reconciled?.mainName, 'Source refreshed')
    assert.deepEqual(buildDirectorMergeInput(10, reconciled?.id ?? null), {
      targetId: 10,
      sourceId: 20
    })
  })

  it('keeps a selected source through a narrower search result and rejects the target itself', () => {
    const selected = candidate(20, 'Source')

    assert.equal(reconcileDirectorMergeSource(selected, [candidate(30, 'Other')]), selected)
    assert.equal(buildDirectorMergeInput(10, null), null)
    assert.equal(buildDirectorMergeInput(10, 10), null)
  })
})
