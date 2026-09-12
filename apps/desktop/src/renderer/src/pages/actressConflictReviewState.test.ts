import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ActressNameConflictGroup } from '@shared/actressConflictTypes'
import {
  buildActressConflictDecisionSnapshot,
  buildActressConflictMergeActors,
  buildConflictQueueSections,
  buildConflictReviewRefreshState,
  canConfirmIllegalName,
  canConfirmMergeActresses,
  CONFLICT_ACTION_SCOPE_LABEL,
  conflictClaimantsNeedingReplacement,
  conflictFieldImpactsForProposedOwner,
  createConflictReviewSelection,
  inspectConflictNameEdit,
  normalizeConflictNameForPreview,
  partitionConflictFieldImpacts,
  selectConflictProposedOwner,
  selectConflictSource,
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
      conflicts: [{ name: 'Collision', normalizedName: 'collision', type: 'alias' }],
      fieldImpactsWhenAssignedToCandidate: [
        {
          field: 'aliases',
          action: 'replace',
          currentValue: [],
          nextValue: ['Collision', 'Other Alias'],
          reason: 'replace'
        }
      ],
      fieldImpacts: [
        {
          field: 'aliases',
          action: 'replace',
          currentValue: [],
          nextValue: ['Other Alias'],
          reason: 'replace'
        }
      ],
      willApplyAfterDecision: true,
      remainingConflictCountAfterDecision: 0
    }
  ]
}

describe('actress conflict review state', () => {
  it('keeps every action tied to its explicit user-visible scope', () => {
    assert.deepEqual(CONFLICT_ACTION_SCOPE_LABEL, {
      editName: '当前来源',
      assignOwnership: '整个名称组',
      mergeActresses: '演员档案',
      markIllegalName: '整个名称组',
      discardScrape: '整份刮削结果',
      applyPending: '整份刮削结果'
    })
  })

  it('expands changed impacts and keeps unchanged impacts collapsed initially', () => {
    const changed = {
      field: 'birthDate' as const,
      action: 'set' as const,
      currentValue: null,
      nextValue: '2000-01-01',
      reason: 'replace' as const
    }
    const unchanged = {
      field: 'heightCm' as const,
      action: 'preserve' as const,
      currentValue: 160,
      nextValue: 160,
      reason: 'existingValue' as const
    }

    assert.deepEqual(partitionConflictFieldImpacts([unchanged, changed]), {
      changed: [changed],
      unchanged: [unchanged],
      unchangedInitiallyOpen: false
    })
  })

  it('uses the candidate-owned impact plan only when that candidate is the proposed owner', () => {
    const candidate = group.candidates[0]
    assert.equal(
      conflictFieldImpactsForProposedOwner(candidate, {
        actressId: candidate.actressId,
        revision: candidate.actressRevision,
        mainName: candidate.actressMainName
      }),
      candidate.fieldImpactsWhenAssignedToCandidate
    )
    assert.equal(
      conflictFieldImpactsForProposedOwner(candidate, group.currentOwner),
      candidate.fieldImpacts
    )
    assert.equal(conflictFieldImpactsForProposedOwner(candidate, null), candidate.fieldImpacts)
  })

  it('sections groups by task state and sorts each section by display name', () => {
    const sections = buildConflictQueueSections([
      { ...group, normalizedName: 'z', displayName: 'Zeta' },
      { ...group, normalizedName: 'a', displayName: 'Alpha' },
      { ...group, status: 'applicable', normalizedName: 'b', displayName: 'Beta' }
    ])

    assert.deepEqual(
      sections.pending.map((item) => item.displayName),
      ['Alpha', 'Zeta']
    )
    assert.deepEqual(
      sections.applicable.map((item) => item.displayName),
      ['Beta']
    )
  })

  it('selects the first source for viewing without preselecting a proposed owner', () => {
    const initial = createConflictReviewSelection(group)
    assert.deepEqual(initial, {
      source: { kind: 'scrape', id: 10 },
      proposedOwner: null,
      tab: 'process'
    })

    const withOwner = selectConflictProposedOwner(initial, {
      actressId: 1,
      revision: 7,
      mainName: 'Collision'
    })
    assert.deepEqual(selectConflictSource(withOwner, { kind: 'claim', id: 99 }), {
      source: { kind: 'claim', id: 99 },
      proposedOwner: { actressId: 1, revision: 7, mainName: 'Collision' },
      tab: 'process'
    })
  })

  it('explains empty, unchanged, moved, and conflict-free name edits', () => {
    assert.equal(normalizeConflictNameForPreview(' Ａ İ '), 'aİ')
    assert.deepEqual(inspectConflictNameEdit('Collision', '  ', [group]), {
      normalizedName: '',
      status: 'empty',
      targetGroupName: null
    })
    assert.deepEqual(inspectConflictNameEdit('Collision', 'Collision', [group]), {
      normalizedName: 'collision',
      status: 'unchanged',
      targetGroupName: 'Collision'
    })
    assert.deepEqual(
      inspectConflictNameEdit('Collision', 'Other Name', [
        group,
        { ...group, normalizedName: 'othername', displayName: 'Other name group' }
      ]),
      {
        normalizedName: 'othername',
        status: 'conflict',
        targetGroupName: 'Other name group'
      }
    )
    assert.deepEqual(inspectConflictNameEdit('Collision', 'Unique Name', [group]), {
      normalizedName: 'uniquename',
      status: 'available',
      targetGroupName: null
    })
  })

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
        hasPending: false,
        blockedPartnerReasons: {}
      },
      {
        actressId: 2,
        revision: 9,
        mainName: 'Target',
        avatarPath: null,
        hasPending: true,
        blockedPartnerReasons: {}
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
        actors.map((actor) =>
          actor.actressId === 2
            ? { ...actor, blockedPartnerReasons: { 1: '第三方冲突' } }
            : actor
        ),
        2,
        1,
        1,
        1
      ),
      false
    )
    assert.equal(
      canConfirmMergeActresses(
        [...actors, { ...actors[0], actressId: 3 }],
        2,
        1,
        1,
        1
      ),
      false
    )
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
      selectConflictGroupAfterRefresh(
        before,
        [before[0], { ...before[1], status: 'applicable' as const }, before[2]],
        'b'
      ),
      'c'
    )
    const applicable = {
      ...group,
      status: 'applicable' as const,
      normalizedName: 'applicable',
      displayName: 'Applicable'
    }
    assert.equal(
      selectConflictGroupAfterRefresh(
        [before[0], before[1], applicable],
        [before[0], applicable],
        'b'
      ),
      'a'
    )
    assert.equal(
      selectConflictGroupAfterRefresh(
        [before[0], applicable],
        [applicable],
        'a'
      ),
      'applicable'
    )
    assert.equal(
      selectConflictGroupAfterRefresh(before, [before[0], before[1]], 'c'),
      'b'
    )
    assert.equal(selectConflictGroupAfterRefresh(before, [], 'b'), null)
    assert.deepEqual(buildConflictReviewRefreshState(before, before, 'b', true), {
      selectedNormalizedName: 'b',
      selection: null,
      staleMessage: '数据已变化，已刷新，请重新确认',
      focusTarget: { kind: 'group', normalizedName: 'b' }
    })
    assert.deepEqual(buildConflictReviewRefreshState(before, [], 'b', false), {
      selectedNormalizedName: null,
      selection: null,
      staleMessage: null,
      focusTarget: { kind: 'complete' }
    })
  })
})
