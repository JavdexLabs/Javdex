import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ActressNameConflictGroup } from '@shared/types'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import {
  deleteActress,
  editActress,
  findActressByNameOrAlias,
  getActressDetail
} from '../db/actressRepo'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import {
  ActressIdentityConflictWorkflow,
  cleanupOrphanedActressScrapeStaging
} from './actressIdentityConflictWorkflow'

let tempRoot: string
let previousUserData: string | undefined

const MINIMAL_JPEG = Buffer.from(
  'ffd8ffe000104a4649460000010101004800480000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191082242b1c11552d1f0243362728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f007b941100ffd9',
  'hex'
)

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-actress-conflict-workflow-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  resetSettingsCacheForTests()
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
})

afterEach(() => {
  closeDatabase()
  resetSettingsCacheForTests()
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

function createActress(mainName: string): number {
  const id = Number(
    getDb()
      .prepare('INSERT INTO actresses (main_name, gender) VALUES (?, ?)')
      .run(mainName, 'female').lastInsertRowid
  )
  editActress(id, { main_name: mainName })
  return id
}

function decisionSnapshot(group: ActressNameConflictGroup) {
  return {
    status: group.status,
    normalizedName: group.normalizedName,
    currentOwnerActressId: group.currentOwner?.actressId ?? null,
    currentOwnerRevision: group.currentOwner?.revision ?? null,
    claimants: group.claimants.map((claimant) => ({
      actressId: claimant.actressId,
      revision: claimant.revision
    })),
    candidates: group.candidates.map((item) => ({
      pendingId: item.pendingId,
      pendingRevision: item.revision,
      actressId: item.actressId,
      actressRevision: item.actressRevision
    }))
  }
}

describe('ActressIdentityConflictWorkflow', () => {
  it('edits only the selected conflicting name and applies the unlocked scrape atomically', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    editActress(ownerId, { aliases: ['Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    assert.equal(
      workflow.processPreparedScrape({
        actressId: targetId,
        plugin: { name: 'Fixture Source', source: 'builtin' },
        queryName: 'Target',
        selectedFields: ['birthDate', 'nameZh'],
        applicableFields: ['birthDate', 'nameZh'],
        mode: 'replace',
        result: { birthDate: '1992-02-02', nameZh: 'Collision' },
        warnings: [],
        resources: []
      }).status,
      'pending'
    )
    const group = workflow.listConflictGroups()[0]
    const candidate = group.candidates[0]

    const outcome = workflow.resolveConflict({
      kind: 'editName',
      snapshot: decisionSnapshot(group),
      pendingId: candidate.pendingId,
      name: 'Collision',
      nameType: 'zh',
      newName: 'Unique Name',
      replacementMainNames: []
    })

    assert.deepEqual(outcome, { status: 'success', remainingPending: 0 })
    const detail = getActressDetail(targetId)
    assert.equal(detail?.birth_date, '1992-02-02')
    assert.equal(detail?.name_zh, 'Unique Name')
    assert.equal(detail?.scraped_status, 1)
    assert.deepEqual(workflow.listConflictGroups(), [])
  })

  it('moves only the edited item when its new name conflicts in another dynamic group', () => {
    const firstOwnerId = createActress('First Owner')
    const secondOwnerId = createActress('Second Owner')
    const editedTargetId = createActress('Edited Target')
    const untouchedTargetId = createActress('Untouched Target')
    editActress(firstOwnerId, { aliases: ['Collision'] })
    editActress(secondOwnerId, { aliases: ['Other Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    for (const actressId of [editedTargetId, untouchedTargetId]) {
      assert.equal(
        workflow.processPreparedScrape({
          actressId,
          plugin: { name: 'Fixture Source', source: 'builtin' },
          queryName: getActressDetail(actressId)?.main_name ?? '',
          selectedFields: ['birthDate', 'aliases'],
          applicableFields: ['birthDate', 'aliases'],
          mode: 'replace',
          result: { birthDate: '1992-02-02', aliases: ['Collision'] },
          warnings: [],
          resources: []
        }).status,
        'pending'
      )
    }
    const group = workflow.listConflictGroups().find(
      (item) => item.normalizedName === 'collision'
    )!
    const edited = group.candidates.find((item) => item.actressId === editedTargetId)!

    assert.equal(
      workflow.resolveConflict({
        kind: 'editName',
      snapshot: decisionSnapshot(group),
        pendingId: edited.pendingId,
        name: 'Collision',
        nameType: 'alias',
        newName: 'Other Collision',
        replacementMainNames: []
      }).status,
      'success'
    )

    const groups = workflow.listConflictGroups()
    assert.deepEqual(
      groups.map((item) => ({
        normalizedName: item.normalizedName,
        candidateIds: item.candidates.map((candidate) => candidate.actressId)
      })),
      [
        { normalizedName: 'collision', candidateIds: [untouchedTargetId] },
        { normalizedName: 'othercollision', candidateIds: [editedTargetId] }
      ]
    )
    assert.equal(
      groups.find((item) => item.normalizedName === 'othercollision')?.candidates[0].revision,
      edited.revision + 1
    )
    assert.equal(getActressDetail(editedTargetId)?.birth_date, null)
  })

  it('moves an edited name into a group claimed by another naturally unlocked pending result', () => {
    const firstOwnerId = createActress('First Owner')
    const secondOwnerId = createActress('Second Owner')
    const firstTargetId = createActress('First Target')
    const secondTargetId = createActress('Second Target')
    editActress(firstOwnerId, { aliases: ['First Collision'] })
    editActress(secondOwnerId, { aliases: ['Second Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    for (const [actressId, alias] of [
      [firstTargetId, 'First Collision'],
      [secondTargetId, 'Second Collision']
    ] as const) {
      workflow.processPreparedScrape({
        actressId,
        plugin: { name: 'Fixture Source', source: 'builtin' },
        queryName: getActressDetail(actressId)?.main_name ?? '',
        selectedFields: ['birthDate', 'aliases'],
        applicableFields: ['birthDate', 'aliases'],
        mode: 'replace',
        result: { birthDate: '1992-02-02', aliases: [alias] },
        warnings: [],
        resources: []
      })
    }
    editActress(secondOwnerId, { aliases: [] })
    const firstGroup = workflow
      .listConflictGroups()
      .find((group) => group.normalizedName === 'firstcollision')!
    const firstCandidate = firstGroup.candidates[0]

    assert.equal(
      workflow.resolveConflict({
        kind: 'editName',
        snapshot: decisionSnapshot(firstGroup),
        pendingId: firstCandidate.pendingId,
        name: 'First Collision',
        nameType: 'alias',
        newName: 'Second Collision',
        replacementMainNames: []
      }).status,
      'success'
    )

    const movedGroup = workflow
      .listConflictGroups()
      .find((group) => group.normalizedName === 'secondcollision')!
    assert.equal(movedGroup.status, 'conflict')
    assert.deepEqual(
      movedGroup.candidates.map((candidate) => candidate.actressId).sort((a, b) => a - b),
      [firstTargetId, secondTargetId].sort((a, b) => a - b)
    )
    assert.equal(getActressDetail(firstTargetId)?.birth_date, null)
    assert.equal(getActressDetail(secondTargetId)?.birth_date, null)
  })

  it('transfers complete ownership to the pending actress only with a replacement main name', () => {
    const ownerId = createActress('Collision')
    const targetId = createActress('Target')
    const workflow = new ActressIdentityConflictWorkflow()
    assert.equal(
      workflow.processPreparedScrape({
        actressId: targetId,
        plugin: { name: 'Fixture Source', source: 'builtin' },
        queryName: 'Target',
        selectedFields: ['birthDate', 'aliases'],
        applicableFields: ['birthDate', 'aliases'],
        mode: 'replace',
        result: { birthDate: '1993-03-03', aliases: ['Collision'] },
        warnings: [],
        resources: []
      }).status,
      'pending'
    )
    const group = workflow.listConflictGroups()[0]
    const candidate = group.candidates[0]
    const baseInput = {
      kind: 'assignToCurrentActress' as const,
      snapshot: decisionSnapshot(group),
      pendingId: candidate.pendingId
    }

    assert.throws(
      () => workflow.resolveConflict({ ...baseInput, replacementMainNames: [] }),
      /必须提供替代主名/
    )
    assert.equal(getActressDetail(ownerId)?.main_name, 'Collision')
    assert.equal(getActressDetail(targetId)?.birth_date, null)

    assert.deepEqual(
      workflow.resolveConflict({
        ...baseInput,
        replacementMainNames: [{ actressId: ownerId, mainName: 'Owner Replacement' }]
      }),
      { status: 'success', remainingPending: 0 }
    )
    assert.equal(getActressDetail(ownerId)?.main_name, 'Owner Replacement')
    assert.equal(getActressDetail(targetId)?.birth_date, '1993-03-03')
    assert.deepEqual(getActressDetail(targetId)?.aliases, ['Collision'])
    assert.equal(findActressByNameOrAlias(' Collision '), targetId)
  })

  it('validates and removes every legacy claimant when assigning to the pending actress', () => {
    const firstClaimantId = createActress('Collision')
    const secondClaimantId = createActress('Second Claimant')
    const targetId = createActress('Target')
    const db = getDb()
    db.prepare('DELETE FROM actress_name_ownership WHERE normalized_name IN (?, ?)').run(
      'collision',
      'secondclaimant'
    )
    db.prepare("UPDATE actresses SET main_name = ? WHERE id = ?").run(
      'C o l l i s i o n',
      secondClaimantId
    )
    db.prepare("UPDATE actress_names SET name = ? WHERE actress_id = ? AND type = 'main'").run(
      'C o l l i s i o n',
      secondClaimantId
    )
    const insertClaim = db.prepare(
      `INSERT INTO pending_actress_name_claims
         (normalized_name, actress_id, name, type, is_primary)
       VALUES (?, ?, ?, 'main', 1)`
    )
    insertClaim.run('collision', firstClaimantId, 'Collision')
    insertClaim.run('collision', secondClaimantId, 'C o l l i s i o n')

    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['birthDate', 'aliases'],
      applicableFields: ['birthDate', 'aliases'],
      mode: 'replace',
      result: { birthDate: '1993-03-03', aliases: ['Collision'] },
      warnings: [],
      resources: []
    })
    const staleGroup = workflow.listConflictGroups()[0]
    assert.equal(staleGroup.currentOwner, null)
    assert.deepEqual(
      staleGroup.claimants.map((claimant) => claimant.actressId),
      [firstClaimantId, secondClaimantId]
    )
    editActress(secondClaimantId, { birth_date: '2000-01-01' })
    assert.equal(
      workflow.resolveConflict({
        kind: 'assignToCurrentActress',
        snapshot: decisionSnapshot(staleGroup),
        pendingId: staleGroup.candidates[0].pendingId,
        replacementMainNames: [
          { actressId: firstClaimantId, mainName: 'First Replacement' },
          { actressId: secondClaimantId, mainName: 'Second Replacement' }
        ]
      }).status,
      'stale'
    )

    const group = workflow.listConflictGroups()[0]
    assert.deepEqual(
      workflow.resolveConflict({
        kind: 'assignToCurrentActress',
        snapshot: decisionSnapshot(group),
        pendingId: group.candidates[0].pendingId,
        replacementMainNames: [
          { actressId: firstClaimantId, mainName: 'First Replacement' },
          { actressId: secondClaimantId, mainName: 'Second Replacement' }
        ]
      }),
      { status: 'success', remainingPending: 0 }
    )
    assert.equal(getActressDetail(firstClaimantId)?.main_name, 'First Replacement')
    assert.equal(getActressDetail(secondClaimantId)?.main_name, 'Second Replacement')
    assert.equal(findActressByNameOrAlias('Collision'), targetId)
    assert.equal(getActressDetail(targetId)?.birth_date, '1993-03-03')
  })

  it('assigns a whole conflict group to an existing actress while applying profiles to original targets', () => {
    const ownerId = createActress('Owner')
    const firstTargetId = createActress('First Target')
    const secondTargetId = createActress('Second Target')
    editActress(ownerId, { aliases: ['Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    assert.equal(
      workflow.processPreparedScrape({
        actressId: firstTargetId,
        plugin: { name: 'First Source', source: 'builtin' },
        queryName: 'First Target',
        selectedFields: ['birthDate', 'nameZh'],
        applicableFields: ['birthDate', 'nameZh'],
        mode: 'replace',
        result: { birthDate: '1991-01-01', nameZh: 'Collision' },
        warnings: [],
        resources: []
      }).status,
      'pending'
    )
    assert.equal(
      workflow.processPreparedScrape({
        actressId: secondTargetId,
        plugin: { name: 'Second Source', source: 'builtin' },
        queryName: 'Second Target',
        selectedFields: ['birthDate', 'aliases'],
        applicableFields: ['birthDate', 'aliases'],
        mode: 'replace',
        result: { birthDate: '1992-02-02', aliases: ['Collision'] },
        warnings: [],
        resources: []
      }).status,
      'pending'
    )
    const group = workflow.listConflictGroups()[0]

    const outcome = workflow.resolveConflict({
      kind: 'assignToExistingActress',
      snapshot: decisionSnapshot(group),
      ownerActressId: ownerId,
      ownerActressRevision: group.currentOwner!.revision,
      replacementMainNames: []
    })

    assert.deepEqual(outcome, { status: 'success', remainingPending: 0 })
    assert.equal(findActressByNameOrAlias('Collision'), ownerId)
    assert.equal(getActressDetail(firstTargetId)?.birth_date, '1991-01-01')
    assert.equal(getActressDetail(firstTargetId)?.name_zh, null)
    assert.equal(getActressDetail(secondTargetId)?.birth_date, '1992-02-02')
    assert.deepEqual(getActressDetail(secondTargetId)?.aliases, [])
  })

  it('keeps confirmed ownership when the chosen existing actress is also a replace candidate', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    editActress(ownerId, { aliases: ['Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['birthDate', 'aliases'],
      applicableFields: ['birthDate', 'aliases'],
      mode: 'replace',
      result: { birthDate: '1991-01-01', aliases: ['Collision', 'Other Alias'] },
      warnings: [],
      resources: []
    })
    const group = workflow.listConflictGroups()[0]
    const targetRevision = group.candidates[0].actressRevision

    assert.deepEqual(
      workflow.resolveConflict({
        kind: 'assignToExistingActress',
        snapshot: decisionSnapshot(group),
        ownerActressId: targetId,
        ownerActressRevision: targetRevision,
        replacementMainNames: []
      }),
      { status: 'success', remainingPending: 0 }
    )
    assert.equal(findActressByNameOrAlias('Collision'), targetId)
    assert.deepEqual(getActressDetail(targetId)?.aliases.sort(), ['Collision', 'Other Alias'])
    assert.equal(getActressDetail(targetId)?.birth_date, '1991-01-01')
  })

  it('requires a replacement when assigning a current main name to a third existing actress', () => {
    const currentOwnerId = createActress('Collision')
    const chosenOwnerId = createActress('Chosen Owner')
    const targetId = createActress('Target')
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['birthDate', 'aliases'],
      applicableFields: ['birthDate', 'aliases'],
      mode: 'replace',
      result: { birthDate: '1996-06-06', aliases: ['Collision'] },
      warnings: [],
      resources: []
    })
    const group = workflow.listConflictGroups()[0]
    const chosenRevision = getActressDetail(chosenOwnerId)!.revision!
    const baseInput = {
      kind: 'assignToExistingActress' as const,
      snapshot: decisionSnapshot(group),
      ownerActressId: chosenOwnerId,
      ownerActressRevision: chosenRevision
    }

    assert.throws(
      () => workflow.resolveConflict({ ...baseInput, replacementMainNames: [] }),
      /必须提供替代主名/
    )
    assert.equal(getActressDetail(currentOwnerId)?.main_name, 'Collision')

    assert.deepEqual(
      workflow.resolveConflict({
        ...baseInput,
        replacementMainNames: [
          { actressId: currentOwnerId, mainName: 'Former Owner Replacement' }
        ]
      }),
      { status: 'success', remainingPending: 0 }
    )
    assert.equal(getActressDetail(currentOwnerId)?.main_name, 'Former Owner Replacement')
    assert.equal(findActressByNameOrAlias('Collision'), chosenOwnerId)
    assert.equal(getActressDetail(targetId)?.birth_date, '1996-06-06')
  })

  it('finishes name-only results and preserves the original fill-empty update mode', () => {
    const ownerId = createActress('Owner')
    const nameOnlyTargetId = createActress('Name Only Target')
    const fillEmptyTargetId = createActress('Fill Empty Target')
    editActress(ownerId, { aliases: ['Collision'] })
    editActress(fillEmptyTargetId, { birth_date: '2001-01-01' })
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: nameOnlyTargetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Name Only Target',
      selectedFields: ['nameZh'],
      applicableFields: ['nameZh'],
      mode: 'replace',
      result: { nameZh: 'Collision' },
      warnings: [],
      resources: []
    })
    workflow.processPreparedScrape({
      actressId: fillEmptyTargetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Fill Empty Target',
      selectedFields: ['birthDate', 'aliases'],
      applicableFields: ['aliases'],
      mode: 'fillEmpty',
      result: { birthDate: '1999-09-09', aliases: ['Collision'] },
      warnings: [],
      resources: []
    })
    const group = workflow.listConflictGroups()[0]

    assert.equal(
      workflow.resolveConflict({
        kind: 'assignToExistingActress',
      snapshot: decisionSnapshot(group),
        ownerActressId: ownerId,
        ownerActressRevision: group.currentOwner!.revision,
        replacementMainNames: []
      }).status,
      'success'
    )
    assert.equal(workflow.countPendingScrapes(), 0)
    assert.equal(getActressDetail(nameOnlyTargetId)?.scraped_status, 1)
    assert.equal(getActressDetail(nameOnlyTargetId)?.name_zh, null)
    assert.equal(getActressDetail(fillEmptyTargetId)?.birth_date, '2001-01-01')
    assert.equal(getActressDetail(fillEmptyTargetId)?.scraped_status, 1)
  })

  it('promotes staged resources when a name edit unlocks a pending scrape', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    editActress(ownerId, { aliases: ['Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    assert.equal(
      workflow.processPreparedScrape({
        actressId: targetId,
        plugin: { name: 'Fixture Source', source: 'builtin' },
        queryName: 'Target',
        selectedFields: ['avatar', 'birthDate', 'aliases'],
        applicableFields: ['avatar', 'birthDate', 'aliases'],
        mode: 'replace',
        result: {
          avatarUrl: 'https://expired.example/avatar.jpg',
          birthDate: '1993-03-03',
          aliases: ['Collision']
        },
        warnings: [],
        resources: [
          {
            field: 'avatar',
            position: 0,
            remoteUrl: 'https://expired.example/avatar.jpg',
            data: MINIMAL_JPEG
          }
        ]
      }).status,
      'pending'
    )
    const group = workflow.listConflictGroups()[0]
    const candidate = group.candidates[0]
    const stagedPath = path.join(
      tempRoot,
      'media_assets',
      candidate.resources[0].stagedPath
    )

    const outcome = workflow.resolveConflict({
      kind: 'editName',
      snapshot: decisionSnapshot(group),
      pendingId: candidate.pendingId,
      name: 'Collision',
      nameType: 'alias',
      newName: 'Unique Name',
      replacementMainNames: []
    })

    assert.equal(outcome.status, 'success')
    const avatarPath = getActressDetail(targetId)?.avatar_path
    assert.ok(avatarPath)
    assert.equal(fs.existsSync(path.join(tempRoot, 'media_assets', avatarPath)), true)
    assert.equal(fs.existsSync(stagedPath), false)
  })

  it('keeps a naturally unlocked result pending until the user explicitly applies it', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    editActress(ownerId, { aliases: ['Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    assert.equal(
      workflow.processPreparedScrape({
        actressId: targetId,
        plugin: { name: 'Fixture Source', source: 'builtin' },
        queryName: 'Target',
        selectedFields: ['birthDate', 'aliases'],
        applicableFields: ['birthDate', 'aliases'],
        mode: 'replace',
        result: { birthDate: '1994-04-04', aliases: ['Collision'] },
        warnings: [],
        resources: []
      }).status,
      'pending'
    )

    editActress(ownerId, { aliases: [] })
    const group = workflow.listConflictGroups()[0]
    assert.equal(group.status, 'applicable')
    assert.equal(getActressDetail(targetId)?.birth_date, null)
    assert.equal(getActressDetail(targetId)?.scraped_status, 0)
    const candidate = group.candidates[0]

    const outcome = workflow.resolveConflict({
      kind: 'applyPending',
      snapshot: decisionSnapshot(group),
      pendingId: candidate.pendingId,
      replacementMainNames: []
    })

    assert.deepEqual(outcome, { status: 'success', remainingPending: 0 })
    assert.equal(getActressDetail(targetId)?.birth_date, '1994-04-04')
    assert.deepEqual(getActressDetail(targetId)?.aliases, ['Collision'])
    assert.equal(getActressDetail(targetId)?.scraped_status, 1)
  })

  it('returns a stale outcome without writes when an involved actress changed', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    editActress(ownerId, { aliases: ['Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['birthDate', 'aliases'],
      applicableFields: ['birthDate', 'aliases'],
      mode: 'replace',
      result: { birthDate: '1994-04-04', aliases: ['Collision'] },
      warnings: [],
      resources: []
    })
    const group = workflow.listConflictGroups()[0]
    const candidate = group.candidates[0]
    editActress(targetId, { birth_date: '2000-01-01' })

    const outcome = workflow.resolveConflict({
      kind: 'editName',
      snapshot: decisionSnapshot(group),
      pendingId: candidate.pendingId,
      name: 'Collision',
      nameType: 'alias',
      newName: 'Unique Name',
      replacementMainNames: []
    })

    assert.deepEqual(outcome, {
      status: 'stale',
      message: '数据已变化，请刷新后重新确认'
    })
    assert.equal(workflow.countPendingScrapes(), 1)
    assert.equal(getActressDetail(targetId)?.birth_date, '2000-01-01')
  })

  it('rolls back every profile and promoted resource when a group apply fails', () => {
    const ownerId = createActress('Owner')
    const firstTargetId = createActress('First Target')
    const secondTargetId = createActress('Second Target')
    editActress(ownerId, { aliases: ['Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    const capture = (actressId: number, withAvatar: boolean) =>
      workflow.processPreparedScrape({
        actressId,
        plugin: { name: 'Fixture Source', source: 'builtin' },
        queryName: getActressDetail(actressId)?.main_name ?? '',
        selectedFields: withAvatar
          ? ['avatar', 'birthDate', 'aliases']
          : ['birthDate', 'aliases'],
        applicableFields: withAvatar
          ? ['avatar', 'birthDate', 'aliases']
          : ['birthDate', 'aliases'],
        mode: 'replace',
        result: {
          ...(withAvatar ? { avatarUrl: 'https://expired.example/avatar.jpg' } : {}),
          birthDate: '1995-05-05',
          aliases: ['Collision']
        },
        warnings: [],
        resources: withAvatar
          ? [
              {
                field: 'avatar' as const,
                position: 0,
                remoteUrl: 'https://expired.example/avatar.jpg',
                data: MINIMAL_JPEG
              }
            ]
          : []
      })
    assert.equal(capture(firstTargetId, true).status, 'pending')
    assert.equal(capture(secondTargetId, false).status, 'pending')
    const group = workflow.listConflictGroups()[0]
    const firstStagedPath = path.join(
      tempRoot,
      'media_assets',
      group.candidates.find((candidate) => candidate.actressId === firstTargetId)!.resources[0]
        .stagedPath
    )
    getDb().exec(`
      CREATE TRIGGER fail_second_group_apply
      BEFORE UPDATE ON actresses
      WHEN OLD.id = ${secondTargetId} AND NEW.birth_date = '1995-05-05'
      BEGIN
        SELECT RAISE(ABORT, 'forced second apply failure');
      END;
    `)

    assert.throws(
      () =>
        workflow.resolveConflict({
          kind: 'assignToExistingActress',
      snapshot: decisionSnapshot(group),
          ownerActressId: ownerId,
          ownerActressRevision: group.currentOwner!.revision,
          replacementMainNames: []
        }),
      /forced second apply failure/
    )

    assert.equal(getActressDetail(firstTargetId)?.birth_date, null)
    assert.equal(getActressDetail(firstTargetId)?.avatar_path, null)
    assert.equal(getActressDetail(secondTargetId)?.birth_date, null)
    assert.equal(workflow.countPendingScrapes(), 2)
    assert.equal(fs.existsSync(firstStagedPath), true)
    const formalFiles = ['avatars', 'actress_gallery'].flatMap((subdir) => {
      const directory = path.join(tempRoot, 'media_assets', subdir)
      return fs.existsSync(directory) ? fs.readdirSync(directory) : []
    })
    assert.deepEqual(formalFiles, [])
  })

  it('freezes the complete scrape when one selected name belongs to another actress', () => {
    const ownerId = createActress('Existing Owner')
    const targetId = createActress('Pending Target')
    editActress(ownerId, { aliases: ['Shared Name'] })
    const workflow = new ActressIdentityConflictWorkflow()

    const outcome = workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'user', version: '1.2.3' },
      queryName: 'Pending Target',
      selectedFields: ['birthDate', 'nameZh'],
      applicableFields: ['birthDate', 'nameZh'],
      mode: 'replace',
      result: { birthDate: '1994-03-02', nameZh: ' Shared  Name ' },
      warnings: [],
      resources: []
    })

    assert.equal(outcome.status, 'pending')
    assert.equal(getActressDetail(targetId)?.birth_date, null)
    assert.equal(getActressDetail(targetId)?.scraped_status, 0)
    assert.deepEqual(
      workflow.listConflictGroups().map((group) => ({
        normalizedName: group.normalizedName,
        ownerId: group.currentOwner?.actressId,
        candidateIds: group.candidates.map((candidate) => candidate.actressId)
      })),
      [{ normalizedName: 'sharedname', ownerId, candidateIds: [targetId] }]
    )
  })

  it('applies a complete result when equivalent names only belong to the target actress', () => {
    const targetId = createActress('Same Actress')
    editActress(targetId, { aliases: ['Shared Name'] })
    const workflow = new ActressIdentityConflictWorkflow()

    const outcome = workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin', version: '1.0.0' },
      queryName: 'Same Actress',
      selectedFields: ['birthDate', 'nameZh', 'aliases'],
      applicableFields: ['birthDate', 'nameZh', 'aliases'],
      mode: 'replace',
      result: {
        birthDate: '1991-07-08',
        nameZh: ' Shared Name ',
        aliases: ['SharedName']
      },
      warnings: [],
      resources: []
    })

    assert.equal(outcome.status, 'success')
    assert.equal(getActressDetail(targetId)?.birth_date, '1991-07-08')
    assert.equal(getActressDetail(targetId)?.scraped_status, 1)
    assert.deepEqual(workflow.listConflictGroups(), [])
  })

  it('atomically replaces one actress current snapshot and removes its old staged resources', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    editActress(ownerId, { aliases: ['Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    const base = {
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'user' as const, version: '1.0.0' },
      queryName: 'Target',
      selectedFields: ['avatar', 'birthDate', 'aliases'] as const,
      applicableFields: ['avatar', 'birthDate', 'aliases'] as const,
      mode: 'replace' as const,
      result: {
        avatarUrl: 'https://example.test/avatar.jpg',
        birthDate: '1990-01-01',
        aliases: ['Collision']
      },
      warnings: ['first warning'],
      resources: [
        {
          field: 'avatar' as const,
          position: 0,
          remoteUrl: 'https://example.test/avatar.jpg',
          data: MINIMAL_JPEG,
          width: 1,
          height: 1
        }
      ]
    }

    const first = workflow.processPreparedScrape({
      ...base,
      selectedFields: [...base.selectedFields],
      applicableFields: [...base.applicableFields]
    })
    assert.equal(first.status, 'pending')
    const firstCandidate = workflow.listConflictGroups()[0].candidates[0]
    const firstPath = path.join(tempRoot, 'media_assets', firstCandidate.resources[0].stagedPath)
    assert.equal(fs.existsSync(firstPath), true)

    const second = workflow.processPreparedScrape({
      ...base,
      selectedFields: [...base.selectedFields],
      applicableFields: [...base.applicableFields],
      result: { ...base.result, birthDate: '1992-02-02' },
      warnings: ['new warning'],
      resources: base.resources.map((resource) => ({ ...resource }))
    })
    assert.equal(second.status, 'pending')
    const groups = workflow.listConflictGroups()
    assert.equal(groups.length, 1)
    assert.equal(groups[0].candidates.length, 1)
    assert.equal(groups[0].candidates[0].result.birthDate, '1992-02-02')
    assert.deepEqual(groups[0].candidates[0].warnings, ['new warning'])
    assert.notEqual(groups[0].candidates[0].pendingId, firstCandidate.pendingId)
    assert.equal(fs.existsSync(firstPath), false)
  })

  it('rolls back a conflict-free apply when removing the previous snapshot fails', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    editActress(ownerId, { aliases: ['Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    const pending = workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['birthDate', 'aliases'],
      applicableFields: ['birthDate', 'aliases'],
      mode: 'replace',
      result: { birthDate: '1990-01-01', aliases: ['Collision'] },
      warnings: [],
      resources: []
    })
    assert.equal(pending.status, 'pending')
    editActress(ownerId, { aliases: [] })
    getDb().exec(`
      CREATE TRIGGER fail_pending_scrape_delete
      BEFORE DELETE ON pending_actress_scrapes
      BEGIN
        SELECT RAISE(ABORT, 'forced pending delete failure');
      END;
    `)

    const outcome = workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['birthDate'],
      applicableFields: ['birthDate'],
      mode: 'replace',
      result: { birthDate: '1992-02-02' },
      warnings: [],
      resources: []
    })

    assert.equal(outcome.status, 'failure')
    assert.equal(getActressDetail(targetId)?.birth_date, null)
    assert.equal(workflow.countPendingScrapes(), 1)
  })

  it('does not delete an existing same-url gallery file when a later apply rolls back', () => {
    const targetId = createActress('Gallery Target')
    const workflow = new ActressIdentityConflictWorkflow()
    const input = {
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' as const },
      queryName: 'Gallery Target',
      selectedFields: ['gallery', 'birthDate'] as const,
      applicableFields: ['gallery', 'birthDate'] as const,
      mode: 'replace' as const,
      result: {
        galleryImageUrls: ['https://example.test/gallery.jpg'],
        birthDate: '1990-01-01'
      },
      warnings: [],
      resources: [
        {
          field: 'gallery' as const,
          position: 0,
          remoteUrl: 'https://example.test/gallery.jpg',
          data: MINIMAL_JPEG
        }
      ]
    }
    assert.equal(
      workflow.processPreparedScrape({
        ...input,
        selectedFields: [...input.selectedFields],
        applicableFields: [...input.applicableFields]
      }).status,
      'success'
    )
    const existing = getDb()
      .prepare('SELECT local_path FROM actress_gallery_assets WHERE actress_id = ?')
      .get(targetId) as { local_path: string }
    const existingAbsPath = path.join(tempRoot, 'media_assets', existing.local_path)
    assert.equal(fs.existsSync(existingAbsPath), true)
    getDb().exec(`
      CREATE TRIGGER fail_gallery_target_update
      BEFORE UPDATE ON actresses
      WHEN NEW.birth_date = '1992-02-02'
      BEGIN
        SELECT RAISE(ABORT, 'forced actress update failure');
      END;
    `)

    const outcome = workflow.processPreparedScrape({
      ...input,
      selectedFields: [...input.selectedFields],
      applicableFields: [...input.applicableFields],
      result: { ...input.result, birthDate: '1992-02-02' },
      resources: input.resources.map((resource) => ({ ...resource }))
    })

    assert.equal(outcome.status, 'failure')
    assert.equal(fs.existsSync(existingAbsPath), true)
    assert.equal(
      (getDb()
        .prepare('SELECT local_path FROM actress_gallery_assets WHERE actress_id = ?')
        .get(targetId) as { local_path: string }).local_path,
      existing.local_path
    )
  })

  it('discards only the selected wrong match, records cumulative failure, and cleans staging', () => {
    const ownerId = createActress('Owner')
    const firstTargetId = createActress('First Target')
    const secondTargetId = createActress('Second Target')
    editActress(ownerId, { aliases: ['Collision'] })
    getDb()
      .prepare(
        `UPDATE actresses
         SET scraped_status = 1, last_scraped_at = '2025-01-01T00:00:00.000Z'
         WHERE id = ?`
      )
      .run(secondTargetId)
    const workflow = new ActressIdentityConflictWorkflow()
    const capture = (actressId: number) =>
      workflow.processPreparedScrape({
        actressId,
        plugin: { name: 'Fixture Source', source: 'user', version: '1.0.0' },
        queryName: getActressDetail(actressId)?.main_name ?? '',
        selectedFields: ['avatar', 'aliases'],
        applicableFields: ['avatar', 'aliases'],
        mode: 'replace',
        result: {
          avatarUrl: `https://example.test/${actressId}.jpg`,
          aliases: ['Collision']
        },
        warnings: [],
        resources: [
          {
            field: 'avatar',
            position: 0,
            remoteUrl: `https://example.test/${actressId}.jpg`,
            data: MINIMAL_JPEG,
            width: 1,
            height: 1
          }
        ]
      })
    assert.equal(capture(firstTargetId).status, 'pending')
    assert.equal(capture(secondTargetId).status, 'pending')
    const before = workflow.listConflictGroups()[0]
    const discarded = before.candidates.find((item) => item.actressId === firstTargetId)
    const remaining = before.candidates.find((item) => item.actressId === secondTargetId)
    assert.ok(discarded)
    assert.ok(remaining)
    const discardedPath = path.join(tempRoot, 'media_assets', discarded.resources[0].stagedPath)
    const remainingPath = path.join(tempRoot, 'media_assets', remaining.resources[0].stagedPath)

    const outcome = workflow.discardPendingScrape({
      pendingId: discarded.pendingId,
      expectedRevision: discarded.revision
    })

    assert.deepEqual(outcome, { remainingPending: 1 })
    assert.equal(getActressDetail(firstTargetId)?.scraped_status, 2)
    assert.equal(getActressDetail(secondTargetId)?.scraped_status, 1)
    assert.equal(fs.existsSync(discardedPath), false)
    assert.equal(fs.existsSync(remainingPath), true)
    assert.deepEqual(
      workflow.listConflictGroups()[0].candidates.map((item) => item.actressId),
      [secondTargetId]
    )
  })

  it('startup cleanup removes only old unreferenced staging directories', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    editActress(ownerId, { aliases: ['Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['avatar', 'aliases'],
      applicableFields: ['avatar', 'aliases'],
      mode: 'replace',
      result: { avatarUrl: 'https://example.test/avatar.jpg', aliases: ['Collision'] },
      warnings: [],
      resources: [
        {
          field: 'avatar',
          position: 0,
          remoteUrl: 'https://example.test/avatar.jpg',
          data: MINIMAL_JPEG
        }
      ]
    })
    const referencedDirectory = path.dirname(
      path.join(
        tempRoot,
        'media_assets',
        workflow.listConflictGroups()[0].candidates[0].resources[0].stagedPath
      )
    )
    const stagingRoot = path.join(tempRoot, 'media_assets', '.actress_scrape_staging')
    const oldOrphan = path.join(stagingRoot, 'old-orphan')
    const recentOrphan = path.join(stagingRoot, 'recent-orphan')
    fs.mkdirSync(oldOrphan, { recursive: true })
    fs.mkdirSync(recentOrphan, { recursive: true })
    fs.writeFileSync(path.join(oldOrphan, 'avatar-0.jpg'), MINIMAL_JPEG)
    fs.writeFileSync(path.join(recentOrphan, 'avatar-0.jpg'), MINIMAL_JPEG)
    const now = Date.parse('2026-01-02T00:00:00.000Z')
    fs.utimesSync(oldOrphan, new Date(now - 48 * 60 * 60 * 1000), new Date(now - 48 * 60 * 60 * 1000))
    fs.utimesSync(recentOrphan, new Date(now - 60 * 1000), new Date(now - 60 * 1000))

    const removed = cleanupOrphanedActressScrapeStaging({ now, olderThanMs: 24 * 60 * 60 * 1000 })

    assert.equal(removed, 1)
    assert.equal(fs.existsSync(oldOrphan), false)
    assert.equal(fs.existsSync(recentOrphan), true)
    assert.equal(fs.existsSync(referencedDirectory), true)
  })

  it('deleting a target actress also removes its staged pending resources', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    editActress(ownerId, { aliases: ['Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['avatar', 'aliases'],
      applicableFields: ['avatar', 'aliases'],
      mode: 'replace',
      result: { avatarUrl: 'https://example.test/avatar.jpg', aliases: ['Collision'] },
      warnings: [],
      resources: [
        {
          field: 'avatar',
          position: 0,
          remoteUrl: 'https://example.test/avatar.jpg',
          data: MINIMAL_JPEG
        }
      ]
    })
    const stagedPath = path.join(
      tempRoot,
      'media_assets',
      workflow.listConflictGroups()[0].candidates[0].resources[0].stagedPath
    )

    deleteActress(targetId)

    assert.equal(fs.existsSync(stagedPath), false)
    assert.equal(workflow.countPendingScrapes(), 0)
  })

  it('removes prepared formal resources when profile application rolls back', () => {
    const targetId = createActress('Rollback Target')
    getDb().exec(`
      CREATE TRIGGER fail_workflow_gallery_insert
      BEFORE INSERT ON actress_gallery_assets
      BEGIN
        SELECT RAISE(ABORT, 'forced gallery failure');
      END;
    `)
    const workflow = new ActressIdentityConflictWorkflow()

    const outcome = workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Rollback Target',
      selectedFields: ['avatar', 'gallery', 'birthDate'],
      applicableFields: ['avatar', 'gallery', 'birthDate'],
      mode: 'replace',
      result: {
        avatarUrl: 'https://example.test/avatar.jpg',
        galleryImageUrls: ['https://example.test/gallery.jpg'],
        birthDate: '1990-01-02'
      },
      warnings: [],
      resources: [
        {
          field: 'avatar',
          position: 0,
          remoteUrl: 'https://example.test/avatar.jpg',
          data: MINIMAL_JPEG
        },
        {
          field: 'gallery',
          position: 0,
          remoteUrl: 'https://example.test/gallery.jpg',
          data: MINIMAL_JPEG
        }
      ]
    })

    assert.equal(outcome.status, 'failure')
    assert.equal(getActressDetail(targetId)?.birth_date, null)
    assert.equal(getActressDetail(targetId)?.avatar_path, null)
    const storedFiles = ['avatars', 'actress_gallery'].flatMap((subdir) => {
      const directory = path.join(tempRoot, 'media_assets', subdir)
      return fs.existsSync(directory) ? fs.readdirSync(directory) : []
    })
    assert.deepEqual(storedFiles, [])
  })
})
