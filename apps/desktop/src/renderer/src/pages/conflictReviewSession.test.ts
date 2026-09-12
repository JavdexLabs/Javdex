import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ActressNameConflictGroup } from '@shared/actressConflictTypes'
import {
  deriveConflictReviewDetail,
  initialConflictReviewSessionState,
  reduceConflictReviewSession
} from './conflictReviewSession'

const candidate = {
  pendingId: 10,
  revision: 1,
  actressId: 2,
  actressRevision: 3,
  actressMainName: '候选演员',
  actressAvatarPath: null,
  plugin: { id: 'test', name: 'Test', version: '1' },
  queryName: '候选演员',
  selectedFields: ['aliases'],
  applicableFields: ['aliases'],
  mode: 'fillEmpty' as const,
  result: { aliases: ['冲突名'] },
  warnings: [],
  createdAt: '2026-08-07T00:00:00.000Z',
  resources: [],
  conflicts: [{ name: '冲突名', normalizedName: '冲突名', type: 'alias' as const }],
  fieldImpactsWhenAssignedToCandidate: [],
  fieldImpacts: [],
  willApplyAfterDecision: true,
  remainingConflictCountAfterDecision: 0
}

function group(withMainClaimant = false): ActressNameConflictGroup {
  return {
    status: 'conflict',
    normalizedName: '冲突名',
    displayName: '冲突名',
    currentOwner: withMainClaimant
      ? {
          actressId: 1,
          revision: 4,
          mainName: '冲突名',
          avatarPath: null,
          nameTypes: ['main'],
          hasPendingScrape: false
        }
      : null,
    claimants: withMainClaimant
      ? [
          {
            actressId: 1,
            revision: 4,
            mainName: '冲突名',
            avatarPath: null,
            nameTypes: ['main'],
            hasPendingScrape: false
          }
        ]
      : [],
    pendingNameClaims: [],
    candidates: [candidate] as unknown as ActressNameConflictGroup['candidates'],
    mergePairs: []
  }
}

describe('conflictReviewSession', () => {
  it('resets decision draft when switching groups', () => {
    const first = group()
    const second = group()
    second.normalizedName = '第二组'
    second.displayName = '第二组'
    second.candidates = [
      {
        ...second.candidates[0],
        pendingId: 20,
        conflicts: [{ name: '第二组', normalizedName: '第二组', type: 'alias' }]
      }
    ]

    let state = reduceConflictReviewSession(initialConflictReviewSessionState, {
      type: 'chooseGroup',
      group: first
    })
    state = reduceConflictReviewSession(state, {
      type: 'selectOwner',
      owner: { actressId: 2, revision: 3, mainName: '候选演员' }
    })
    state = reduceConflictReviewSession(state, { type: 'openIllegalName' })
    assert.equal(state.replacementDialog, 'illegal')
    assert.equal(state.selection?.proposedOwner?.actressId, 2)

    state = reduceConflictReviewSession(state, { type: 'chooseGroup', group: second })
    assert.equal(state.selectedName, '第二组')
    assert.equal(state.selection?.source?.kind, 'scrape')
    assert.equal(state.selection?.source?.id, 20)
    assert.equal(state.selection?.proposedOwner, null)
    assert.equal(state.replacementDialog, null)
  })

  it('opens ownership replacement dialog when claimants need new main names', () => {
    const selected = group(true)
    let state = reduceConflictReviewSession(initialConflictReviewSessionState, {
      type: 'chooseGroup',
      group: selected
    })
    state = reduceConflictReviewSession(state, {
      type: 'selectOwner',
      owner: { actressId: 2, revision: 3, mainName: '候选演员' }
    })
    state = reduceConflictReviewSession(state, { type: 'openOwnershipReplacement' })
    const derived = deriveConflictReviewDetail(state, [selected], state.editedName)
    assert.equal(state.replacementDialog, 'ownership')
    assert.equal(derived.requiredReplacementClaimants.length, 1)
    assert.equal(derived.canSubmitReplacement, false)

    state = reduceConflictReviewSession(state, {
      type: 'changeReplacementMainName',
      actressId: 1,
      value: '正确主名'
    })
    state = reduceConflictReviewSession(state, {
      type: 'patch',
      patch: { replacementValidationStatus: 'valid' }
    })
    assert.equal(
      deriveConflictReviewDetail(state, [selected], state.editedName).canSubmitReplacement,
      true
    )
  })

  it('applies refresh focus and stale message', () => {
    const previous = [group()]
    const refreshed = [group()]
    refreshed[0].normalizedName = '下一组'
    refreshed[0].displayName = '下一组'
    let state = reduceConflictReviewSession(initialConflictReviewSessionState, {
      type: 'chooseGroup',
      group: previous[0]
    })
    state = reduceConflictReviewSession(state, {
      type: 'applyRefresh',
      previousGroups: previous,
      refreshedGroups: refreshed,
      previousSelectedName: '冲突名',
      stale: true
    })
    assert.equal(state.staleMessage, '数据已变化，已刷新，请重新确认')
    assert.equal(state.focusAfterRefresh, '下一组')
    assert.equal(state.selectionGroupName, null)
    assert.equal(state.selection, null)

    state = reduceConflictReviewSession(state, { type: 'focusHandled' })
    assert.equal(state.focusAfterRefresh, undefined)
  })

  it('syncSelectedGroup initializes selection for the first available group', () => {
    const selected = group()
    const state = reduceConflictReviewSession(initialConflictReviewSessionState, {
      type: 'syncSelectedGroup',
      group: selected
    })
    assert.equal(state.selectedName, '冲突名')
    assert.equal(state.selectionGroupName, '冲突名')
    assert.equal(state.selection?.source?.id, 10)
  })
})
