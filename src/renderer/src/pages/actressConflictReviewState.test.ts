import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ActressNameConflictGroup } from '@shared/types'
import {
  buildActressConflictDecisionSnapshot,
  conflictClaimantsNeedingReplacement
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
    nameTypes: ['main', 'alias']
  },
  claimants: [
    {
      actressId: 1,
      revision: 7,
      mainName: 'Collision',
      avatarPath: null,
      nameTypes: ['main', 'alias']
    }
  ],
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
})
