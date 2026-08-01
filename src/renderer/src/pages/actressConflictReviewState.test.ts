import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ActressNameConflictGroup } from '@shared/types'
import {
  buildActressConflictDecisionSnapshot,
  buildActressConflictMergeActors,
  canConfirmIllegalName,
  canConfirmMergeActresses,
  conflictClaimantsNeedingReplacement,
  selectConflictGroupAfterRefresh
} from './actressConflictReviewState'

const group: ActressNameConflictGroup = {
  status: 'conflict',
  normalizedName: 'collision',
  displayName: 'Collision',
  currentOwner: {
    actressId: 1,
    revision: 7,
    mainName: 'Collision',
    avatarPath: null,
    nameTypes: ['main', 'alias'],
    hasPendingScrape: false
  },
  claimants: [
    {
      actressId: 1,
      revision: 7,
      mainName: 'Collision',
      avatarPath: null,
      nameTypes: ['main', 'alias'],
      hasPendingScrape: false
    }
  ],
  pendingNameClaims: [],
  candidates: [
    {
      pendingId: 10,
      revision: 3,
      actressId: 2,
      actressRevision: 9,
      actressMainName: 'Target',
      actressAvatarPath: null,
      plugin: { name: 'Fixture', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['aliases'],
      applicableFields: ['aliases'],
      mode: 'replace',
      result: { aliases: ['Collision'] },
      warnings: [],
      createdAt: '2026-08-01T00:00:00.000Z',
      resources: [],
      conflicts: [{ name: 'Collision', normalizedName: 'collision', type: 'alias' }]
    }
  ]
}

describe('actress conflict review state', () => {
  it('builds the exact owner, pending, and actress versions shown to the user', () => {
    assert.deepEqual(buildActressConflictDecisionSnapshot(group), {
      status: 'conflict',
      normalizedName: 'collision',
      currentOwnerActressId: 1,
      currentOwnerRevision: 7,
      claimants: [{ actressId: 1, revision: 7 }],
      pendingNameClaims: [],
      candidates: [
        {
          pendingId: 10,
          pendingRevision: 3,
          actressId: 2,
          actressRevision: 9
        }
      ]
    })
  })

  it('requires a replacement only when assigning away a current main name', () => {
    assert.deepEqual(conflictClaimantsNeedingReplacement(group, 2), group.claimants)
    assert.deepEqual(conflictClaimantsNeedingReplacement(group, 1), [])
    assert.deepEqual(conflictClaimantsNeedingReplacement(group, 3), group.claimants)
    assert.deepEqual(
      conflictClaimantsNeedingReplacement(
        { ...group, claimants: [{ ...group.claimants[0], nameTypes: ['alias'] }] },
        2
      ),
      []
    )
  })

  it('enables illegal-name confirmation only after every required replacement is valid', () => {
    assert.equal(canConfirmIllegalName([], {}, 'idle'), true)
    assert.equal(canConfirmIllegalName(group.claimants, {}, 'idle'), false)
    assert.equal(
      canConfirmIllegalName(group.claimants, { 1: 'Owner Replacement' }, 'checking'),
      false
    )
    assert.equal(
      canConfirmIllegalName(group.claimants, { 1: 'Owner Replacement' }, 'invalid'),
      false
    )
    assert.equal(
      canConfirmIllegalName(group.claimants, { 1: 'Owner Replacement' }, 'stale'),
      false
    )
    assert.equal(
      canConfirmIllegalName(group.claimants, { 1: 'Owner Replacement' }, 'valid'),
      true
    )
  })

  it('requires an explicit partner, keeper, and final main name for conflict merges', () => {
    const actors = buildActressConflictMergeActors(group)
    assert.deepEqual(actors, [
      {
        actressId: 1,
        revision: 7,
        mainName: 'Collision',
        avatarPath: null,
        hasPending: false
      },
      {
        actressId: 2,
        revision: 9,
        mainName: 'Target',
        avatarPath: null,
        hasPending: true
      }
    ])
    assert.equal(canConfirmMergeActresses(actors, 2, null, null, null), false)
    assert.equal(canConfirmMergeActresses(actors, 2, 1, null, null), false)
    assert.equal(canConfirmMergeActresses(actors, 2, 1, 1, null), false)
    assert.equal(canConfirmMergeActresses(actors, 2, 1, 1, 1), true)
    assert.equal(canConfirmMergeActresses(actors, 2, 1, 1, 1, false), false)
    assert.equal(canConfirmMergeActresses(actors, 2, 1, 1, 3), false)
    assert.equal(
      canConfirmMergeActresses(
        actors.map((actor) => ({ ...actor, hasPending: true })),
        2,
        1,
        1,
        1
      ),
      false
    )
  })

  it('allows a pending-name-ownership pair to be merged', () => {
    const actors = buildActressConflictMergeActors({
      ...group,
      currentOwner: null,
      candidates: [],
      claimants: [
        group.claimants[0],
        {
          actressId: 2,
          revision: 9,
          mainName: 'Other',
          avatarPath: null,
          nameTypes: ['main'],
          hasPendingScrape: false
        }
      ]
    })
    assert.equal(canConfirmMergeActresses(actors, 1, 2, 1, 1), true)
  })

  it('keeps the current group or selects its next neighbor after refresh', () => {
    const before = [
      { ...group, normalizedName: 'a' },
      { ...group, normalizedName: 'b' },
      { ...group, normalizedName: 'c' }
    ]
    assert.equal(selectConflictGroupAfterRefresh(before, before, 'b'), 'b')
    assert.equal(
      selectConflictGroupAfterRefresh(before, [before[0], before[2]], 'b'),
      'c'
    )
    assert.equal(
      selectConflictGroupAfterRefresh(before, [before[0], before[1]], 'c'),
      'b'
    )
    assert.equal(selectConflictGroupAfterRefresh(before, [], 'b'), null)
  })
})
