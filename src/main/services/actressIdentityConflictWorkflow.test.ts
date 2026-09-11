import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { normalizeActressName } from '../db/actressNameNormalization'
import type { ActressNameConflictGroup } from '@shared/actressConflictTypes'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import {
  editActress,
  findActressByNameOrAlias,
  getActressDetail
} from '../db/actressRepo'
import { createActressMaintenanceService } from './actressMaintenanceService'
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

function createPendingNameOwnershipCollision(): { firstId: number; secondId: number } {
  const firstId = createActress('Collision')
  const secondId = createActress('Second Claimant')
  const db = getDb()
  db.prepare('DELETE FROM actress_name_ownership WHERE normalized_name IN (?, ?)').run(
    'collision',
    'secondclaimant'
  )
  db.prepare('UPDATE actresses SET main_name = ? WHERE id = ?').run(
    'C o l l i s i o n',
    secondId
  )
  db.prepare("UPDATE actress_names SET name = ? WHERE actress_id = ? AND type = 'main'").run(
    'C o l l i s i o n',
    secondId
  )
  const insertClaim = db.prepare(
    `INSERT INTO pending_actress_name_claims
       (normalized_name, actress_id, name, type, is_primary)
     VALUES (?, ?, ?, 'main', 1)`
  )
  insertClaim.run('collision', firstId, 'Collision')
  insertClaim.run('collision', secondId, 'C o l l i s i o n')
  return { firstId, secondId }
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
    pendingNameClaims: group.pendingNameClaims.map((claim) => ({
      claimId: claim.claimId,
      actressId: claim.actressId,
      name: claim.name,
      type: claim.type
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
  it('inspects live ownership even when the name is not yet in a review group', () => {
    const ownerId = createActress('Already Owned')
    const targetId = createActress('Target')
    const workflow = new ActressIdentityConflictWorkflow()

    assert.deepEqual(
      workflow.inspectConflictName({ actressId: targetId, name: 'AlreadyOwned' }),
      { normalizedName: 'alreadyowned', status: 'conflict' }
    )
    assert.deepEqual(
      workflow.inspectConflictName({ actressId: ownerId, name: 'Already Owned' }),
      { normalizedName: 'alreadyowned', status: 'available' }
    )
    assert.deepEqual(workflow.listConflictGroups(), [])
  })

  it('summarizes the same aggregated name groups returned by the review list', () => {
    createPendingNameOwnershipCollision()
    const workflow = new ActressIdentityConflictWorkflow()

    assert.equal(workflow.listConflictGroups().length, 1)
    assert.deepEqual(workflow.getConflictReviewSummary(), {
      groupCount: 1,
      conflictGroupCount: 1,
      applicableGroupCount: 0,
      pendingScrapeCount: 0,
      pendingNameClaimGroupCount: 1
    })
  })

  it('keeps summary counts exact for mixed, multi-result, and multi-conflict groups', () => {
    createPendingNameOwnershipCollision()
    const sharedOwnerId = createActress('Shared Owner')
    const otherOwnerId = createActress('Other Owner')
    const naturalOwnerId = createActress('Natural Owner')
    editActress(sharedOwnerId, { aliases: ['Shared Collision'] })
    editActress(otherOwnerId, { aliases: ['Other Collision'] })
    editActress(naturalOwnerId, { aliases: ['Natural Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    const targets = [createActress('First Target'), createActress('Second Target')]
    for (const targetId of targets) {
      workflow.processPreparedScrape({
        actressId: targetId,
        plugin: { name: 'Fixture Source', source: 'builtin' },
        queryName: getActressDetail(targetId)!.main_name,
        selectedFields: ['aliases'],
        applicableFields: ['aliases'],
        mode: 'replace',
        result: { aliases: ['Shared Collision'] },
        warnings: [],
        resources: []
      })
    }
    const multiTargetId = createActress('Multi Target')
    workflow.processPreparedScrape({
      actressId: multiTargetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Multi Target',
      selectedFields: ['aliases'],
      applicableFields: ['aliases'],
      mode: 'replace',
      result: { aliases: ['Shared Collision', 'Other Collision'] },
      warnings: [],
      resources: []
    })
    const naturalTargetId = createActress('Natural Target')
    workflow.processPreparedScrape({
      actressId: naturalTargetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Natural Target',
      selectedFields: ['aliases'],
      applicableFields: ['aliases'],
      mode: 'replace',
      result: { aliases: ['Natural Collision'] },
      warnings: [],
      resources: []
    })
    editActress(naturalOwnerId, { aliases: [] })

    getDb().exec(`INSERT INTO pending_actress_scrape_resources(pending_scrape_id,field,position,remote_url,staged_path,width,height)
      SELECT id,'avatar',0,'https://example.test/avatar','/synthetic/avatar-'||id,20,30 FROM pending_actress_scrapes;
      INSERT INTO pending_actress_scrape_resources(pending_scrape_id,field,position,remote_url,staged_path,width,height)
      SELECT id,'gallery',0,'https://example.test/gallery','/synthetic/gallery-'||id,40,50 FROM pending_actress_scrapes;`)
    const groups = workflow.listConflictGroups()
    assert.ok(groups.some(group => group.candidates.some(candidate => candidate.resources.length === 2)))
    const expectedQueue = groups.map(group => ({normalizedName:group.normalizedName,displayName:group.displayName,
      status:group.status,candidateCount:group.candidates.length,pendingNameClaimCount:group.pendingNameClaims.length,
      avatarPath:group.candidates[0]?.actressAvatarPath ?? null}))
    const firstPage = workflow.pageConflictQueue({limit:2})
    const secondPage = workflow.pageConflictQueue({limit:2,offset:2})
    assert.equal(firstPage.total,groups.length)
    assert.deepEqual([...firstPage.items,...secondPage.items],expectedQueue)
    for (const [rank,group] of groups.entries()) {
      assert.deepEqual(workflow.getConflictGroup(group.normalizedName),group)
      const located = workflow.pageConflictQueue({limit:2,anchorName:group.normalizedName})
      assert.equal(located.offset,Math.floor(rank/2)*2)
      assert.ok(located.items.some(item=>item.normalizedName===group.normalizedName))
    }
    assert.equal(
      groups.find((group) => group.normalizedName === 'sharedcollision')?.candidates.length,
      3
    )
    assert.equal(
      groups.find((group) => group.normalizedName === 'othercollision')?.candidates[0]
        .actressId,
      multiTargetId
    )
    assert.equal(
      groups.find((group) => group.normalizedName === 'naturalcollision')?.status,
      'applicable'
    )
    assert.deepEqual(workflow.getConflictReviewSummary(), {
      groupCount: groups.length,
      conflictGroupCount: groups.filter((group) => group.status === 'conflict').length,
      applicableGroupCount: groups.filter((group) => group.status === 'applicable').length,
      pendingScrapeCount: 4,
      pendingNameClaimGroupCount: 1
    })
  })

  it('lists pending name ownership without inventing a pending scrape', () => {
    const { firstId: firstClaimantId, secondId: secondClaimantId } =
      createPendingNameOwnershipCollision()

    const workflow = new ActressIdentityConflictWorkflow()
    const groups = workflow.listConflictGroups()

    assert.equal(workflow.countPendingScrapes(), 0)
    assert.equal(workflow.countPendingReviewItems(), 1)
    assert.equal(groups.length, 1)
    assert.equal(groups[0].normalizedName, 'collision')
    assert.equal(groups[0].currentOwner, null)
    assert.deepEqual(
      groups[0].claimants.map((claimant) => claimant.actressId),
      [firstClaimantId, secondClaimantId]
    )
    assert.deepEqual(groups[0].candidates, [])
  })

  it('rejects an unsupported pending name type instead of silently reclassifying it', () => {
    createPendingNameOwnershipCollision()
    getDb()
      .prepare(
        `UPDATE pending_actress_name_claims
         SET type = 'unsupported'
         WHERE id = (SELECT MIN(id) FROM pending_actress_name_claims)`
      )
      .run()

    assert.throws(
      () => new ActressIdentityConflictWorkflow().listConflictGroups(),
      /不支持的待确认名称类型：unsupported/
    )
  })

  it('rejects a pending-name-ownership decision when the shown claim row changed', () => {
    const { firstId, secondId } = createPendingNameOwnershipCollision()
    const db = getDb()
    const workflow = new ActressIdentityConflictWorkflow()
    const group = workflow.listConflictGroups()[0]
    db.prepare('UPDATE pending_actress_name_claims SET name = ? WHERE id = ?').run(
      'Changed Behind UI',
      group.pendingNameClaims[0].claimId
    )

    assert.deepEqual(
      workflow.resolveConflict({
        kind: 'markIllegalName',
        snapshot: decisionSnapshot(group),
        replacementMainNames: [
          { actressId: firstId, mainName: 'First Replacement' },
          { actressId: secondId, mainName: 'Second Replacement' }
        ]
      }),
      { status: 'stale', message: '数据已变化，请刷新后重新确认' }
    )
    assert.equal(getActressDetail(firstId)?.main_name, 'Collision')
    assert.equal(getActressDetail(secondId)?.main_name, 'C o l l i s i o n')
  })

  it('assigns pending name ownership without creating or applying scrape data', () => {
    const { firstId: ownerId, secondId: otherId } = createPendingNameOwnershipCollision()
    const workflow = new ActressIdentityConflictWorkflow()
    const group = workflow.listConflictGroups()[0]

    const outcome = workflow.resolveConflict({
      kind: 'assignToExistingActress',
      snapshot: decisionSnapshot(group),
      ownerActressId: ownerId,
      ownerActressRevision: group.claimants.find((item) => item.actressId === ownerId)!.revision,
      replacementMainNames: [{ actressId: otherId, mainName: 'Second Replacement' }]
    })

    assert.deepEqual(outcome, { status: 'success', remainingPending: 0 })
    assert.equal(findActressByNameOrAlias('Collision'), ownerId)
    assert.equal(getActressDetail(otherId)?.main_name, 'Second Replacement')
    assert.equal(workflow.countPendingScrapes(), 0)
    assert.equal(workflow.countPendingReviewItems(), 0)
    assert.deepEqual(workflow.listConflictGroups(), [])
  })

  it('edits one pending name claim and resolves both resulting unique owners', () => {
    const { firstId, secondId: editedId } = createPendingNameOwnershipCollision()
    const workflow = new ActressIdentityConflictWorkflow()
    const group = workflow.listConflictGroups()[0]
    const selected = group.pendingNameClaims.find((claim) => claim.actressId === editedId)!

    const outcome = workflow.resolveConflict({
      kind: 'editPendingNameClaim',
      snapshot: decisionSnapshot(group),
      claimId: selected.claimId,
      actressId: editedId,
      name: selected.name,
      nameType: selected.type,
      newName: 'Second Resolved',
      replacementMainNames: []
    })

    assert.deepEqual(outcome, { status: 'success', remainingPending: 0 })
    assert.equal(findActressByNameOrAlias('Collision'), firstId)
    assert.equal(findActressByNameOrAlias('Second Resolved'), editedId)
    assert.equal(getActressDetail(editedId)?.main_name, 'Second Resolved')
    assert.equal(workflow.countPendingScrapes(), 0)
    assert.deepEqual(workflow.listConflictGroups(), [])
  })

  it('moves an edited pending name claim into another normalized-name group', () => {
    const { firstId, secondId } = createPendingNameOwnershipCollision()
    const occupiedId = createActress('Occupied Name')
    const workflow = new ActressIdentityConflictWorkflow()
    const group = workflow.listConflictGroups()[0]
    const selected = group.pendingNameClaims.find((claim) => claim.actressId === secondId)!

    const outcome = workflow.resolveConflict({
      kind: 'editPendingNameClaim',
      snapshot: decisionSnapshot(group),
      claimId: selected.claimId,
      actressId: secondId,
      name: selected.name,
      nameType: selected.type,
      newName: 'OccupiedName',
      replacementMainNames: []
    })

    assert.deepEqual(outcome, { status: 'success', remainingPending: 1 })
    assert.equal(findActressByNameOrAlias('Collision'), firstId)
    assert.equal(findActressByNameOrAlias('Occupied Name'), null)
    assert.equal(getActressDetail(secondId)?.main_name, 'OccupiedName')
    const movedGroup = workflow.listConflictGroups()[0]
    assert.equal(movedGroup.normalizedName, 'occupiedname')
    assert.deepEqual(
      movedGroup.claimants.map((claimant) => claimant.actressId),
      [secondId, occupiedId]
    )
    assert.equal(movedGroup.pendingNameClaims.length, 2)
    assert.deepEqual(movedGroup.candidates, [])
  })

  it('merges actresses directly from pending name ownership', () => {
    const { firstId: keepId, secondId: mergeId } = createPendingNameOwnershipCollision()
    const workflow = new ActressIdentityConflictWorkflow()
    const group = workflow.listConflictGroups()[0]
    const keep = group.claimants.find((item) => item.actressId === keepId)!
    const merged = group.claimants.find((item) => item.actressId === mergeId)!

    const outcome = workflow.resolveConflict({
      kind: 'mergeActresses',
      snapshot: decisionSnapshot(group),
      keepActressId: keepId,
      keepActressRevision: keep.revision,
      mergeActressId: mergeId,
      mergeActressRevision: merged.revision,
      finalMainName: keep.mainName,
      replacementMainNames: []
    })

    assert.deepEqual(outcome, { status: 'success', remainingPending: 0 })
    assert.equal(getActressDetail(mergeId), null)
    assert.equal(findActressByNameOrAlias('Collision'), keepId)
    assert.equal(workflow.countPendingScrapes(), 0)
    assert.deepEqual(workflow.listConflictGroups(), [])
  })

  it('removes an illegal pending name without persisting a blacklist', () => {
    const firstId = createActress('First Claimant')
    const secondId = createActress('Second Claimant')
    const db = getDb()
    const insertName = db.prepare(
      `INSERT INTO actress_names (actress_id, name, type, is_primary)
       VALUES (?, ?, 'alias', 0)`
    )
    insertName.run(firstId, '作品一覧')
    insertName.run(secondId, '作 品 一 覧')
    const insertClaim = db.prepare(
      `INSERT INTO pending_actress_name_claims
         (normalized_name, actress_id, name, type, is_primary)
       VALUES (?, ?, ?, 'alias', 0)`
    )
    insertClaim.run('作品一覧', firstId, '作品一覧')
    insertClaim.run('作品一覧', secondId, '作 品 一 覧')
    const workflow = new ActressIdentityConflictWorkflow()
    const group = workflow.listConflictGroups()[0]

    const outcome = workflow.resolveConflict({
      kind: 'markIllegalName',
      snapshot: decisionSnapshot(group),
      replacementMainNames: []
    })

    assert.deepEqual(outcome, { status: 'success', remainingPending: 0 })
    assert.equal(getActressDetail(firstId)?.main_name, 'First Claimant')
    assert.equal(getActressDetail(secondId)?.main_name, 'Second Claimant')
    assert.equal(findActressByNameOrAlias('作品一覧'), null)
    assert.deepEqual(workflow.listConflictGroups(), [])
  })

  it('reassigns the only pending scrape to the explicit keeper after a merge', () => {
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
        result: { birthDate: '1992-02-02', aliases: ['Collision'] },
        warnings: [],
        resources: []
      }).status,
      'pending'
    )
    const group = workflow.listConflictGroups()[0]
    const candidate = group.candidates[0]

    const outcome = workflow.resolveConflict({
      kind: 'mergeActresses',
      snapshot: decisionSnapshot(group),
      keepActressId: ownerId,
      keepActressRevision: group.currentOwner!.revision,
      mergeActressId: targetId,
      mergeActressRevision: candidate.actressRevision,
      finalMainName: 'Owner',
      replacementMainNames: []
    })

    assert.deepEqual(outcome, { status: 'success', remainingPending: 1 })
    assert.equal(getActressDetail(targetId), null)
    assert.equal(getActressDetail(ownerId)?.birth_date, null)
    const applicable = workflow.listConflictGroups()[0]
    assert.equal(applicable.status, 'applicable')
    assert.equal(applicable.candidates[0].pendingId, candidate.pendingId)
    assert.equal(applicable.candidates[0].actressId, ownerId)
    assert.equal(applicable.candidates[0].revision, candidate.revision + 1)
  })

  it('keeps a usable keeper avatar while clearing its missing source and crop state', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    const avatarDirectory = path.join(tempRoot, 'media_assets', 'avatars')
    fs.mkdirSync(avatarDirectory, { recursive: true })
    fs.writeFileSync(path.join(avatarDirectory, 'owner.jpg'), MINIMAL_JPEG)
    fs.writeFileSync(path.join(avatarDirectory, 'target.jpg'), MINIMAL_JPEG)
    getDb()
      .prepare(
        `UPDATE actresses
         SET avatar_path = ?, avatar_source_path = ?, avatar_crop_json = ?
         WHERE id = ?`
      )
      .run('avatars/owner.jpg', 'avatars/missing-source.jpg', '{"version":1}', ownerId)
    getDb()
      .prepare('UPDATE actresses SET avatar_path = ? WHERE id = ?')
      .run('avatars/target.jpg', targetId)
    editActress(ownerId, { aliases: ['Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['aliases'],
      applicableFields: ['aliases'],
      mode: 'replace',
      result: { aliases: ['Collision'] },
      warnings: [],
      resources: []
    })
    const group = workflow.listConflictGroups()[0]
    const candidate = group.candidates[0]

    workflow.resolveConflict({
      kind: 'mergeActresses',
      snapshot: decisionSnapshot(group),
      pendingId: candidate.pendingId,
      keepActressId: ownerId,
      keepActressRevision: group.currentOwner!.revision,
      mergeActressId: targetId,
      mergeActressRevision: candidate.actressRevision,
      finalMainName: 'Owner',
      replacementMainNames: []
    })

    const keeper = getActressDetail(ownerId)
    assert.equal(keeper?.avatar_path, 'avatars/owner.jpg')
    assert.equal(keeper?.avatar_source_path, null)
    assert.equal(keeper?.avatar_crop_json, null)
    assert.equal(fs.existsSync(path.join(avatarDirectory, 'owner.jpg')), true)
    assert.equal(fs.existsSync(path.join(avatarDirectory, 'target.jpg')), false)
  })

  it('uses the explicitly selected pending actress as keeper and the other current main name', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    editActress(ownerId, { aliases: ['Collision'], birth_date: '1988-08-08', cup_size: 'F' })
    editActress(targetId, { cup_size: 'C' })
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['aliases'],
      applicableFields: ['aliases'],
      mode: 'replace',
      result: { aliases: ['Collision'] },
      warnings: [],
      resources: []
    })
    const group = workflow.listConflictGroups()[0]
    const candidate = group.candidates[0]

    workflow.resolveConflict({
      kind: 'mergeActresses',
      snapshot: decisionSnapshot(group),
      pendingId: candidate.pendingId,
      keepActressId: targetId,
      keepActressRevision: candidate.actressRevision,
      mergeActressId: ownerId,
      mergeActressRevision: group.currentOwner!.revision,
      finalMainName: 'Owner',
      replacementMainNames: []
    })

    const keeper = getActressDetail(targetId)
    assert.equal(getActressDetail(ownerId), null)
    assert.equal(keeper?.main_name, 'Owner')
    assert.equal(keeper?.birth_date, '1988-08-08')
    assert.equal(keeper?.cup_size, 'C')
    assert.ok(keeper?.aliases.includes('Target'))
    const applicable = workflow.listConflictGroups()[0]
    assert.equal(applicable.status, 'applicable')
    assert.equal(applicable.candidates[0].actressId, targetId)
    assert.equal(applicable.candidates[0].revision, candidate.revision + 1)
  })

  it('rejects merging when both actresses own pending scrape snapshots', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    const thirdId = createActress('Third')
    editActress(ownerId, { aliases: ['Collision'] })
    editActress(thirdId, { aliases: ['Other Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: ownerId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Owner',
      selectedFields: ['aliases'],
      applicableFields: ['aliases'],
      mode: 'replace',
      result: { aliases: ['Other Collision'] },
      warnings: [],
      resources: []
    })
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['aliases'],
      applicableFields: ['aliases'],
      mode: 'replace',
      result: { aliases: ['Collision'] },
      warnings: [],
      resources: []
    })
    const group = workflow
      .listConflictGroups()
      .find((item) => item.normalizedName === 'collision')!
    const candidate = group.candidates[0]

    assert.throws(
      () =>
        workflow.resolveConflict({
          kind: 'mergeActresses',
          snapshot: decisionSnapshot(group),
          pendingId: candidate.pendingId,
          keepActressId: ownerId,
          keepActressRevision: group.currentOwner!.revision,
          mergeActressId: targetId,
          mergeActressRevision: candidate.actressRevision,
          finalMainName: 'Owner',
          replacementMainNames: []
        }),
      /两位演员都有待确认刮削结果/
    )
    assert.ok(getActressDetail(ownerId))
    assert.ok(getActressDetail(targetId))
    assert.equal(workflow.countPendingScrapes(), 2)
  })

  it('does not treat another conflict between the same actress pair as a merge blocker', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    editActress(ownerId, { aliases: ['Pair Collision', 'Second Pair Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['aliases'],
      applicableFields: ['aliases'],
      mode: 'replace',
      result: { aliases: ['Pair Collision', 'Second Pair Collision'] },
      warnings: [],
      resources: []
    })

    const group = workflow
      .listConflictGroups()
      .find((item) => item.normalizedName === 'paircollision')!

    assert.equal(group.candidates[0].remainingConflictCountAfterDecision, 1)
    assert.deepEqual(group.mergePairs, [
      { actressIds: [ownerId, targetId], blockedReason: null }
    ])
  })

  it('rejects the whole workbench merge when a resulting name belongs to a third actress', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    const thirdId = createActress('Third')
    editActress(ownerId, { aliases: ['Collision'] })
    editActress(thirdId, { aliases: ['Third-party Name'] })
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['aliases'],
      applicableFields: ['aliases'],
      mode: 'replace',
      result: { aliases: ['Collision'] },
      warnings: [],
      resources: []
    })
    const group = workflow.listConflictGroups()[0]
    const candidate = group.candidates[0]
    getDb()
      .prepare(
        "INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, 'alias', 0)"
      )
      .run(targetId, 'Third-party Name')

    assert.throws(
      () =>
        workflow.resolveConflict({
          kind: 'mergeActresses',
          snapshot: decisionSnapshot(group),
          pendingId: candidate.pendingId,
          keepActressId: ownerId,
          keepActressRevision: group.currentOwner!.revision,
          mergeActressId: targetId,
          mergeActressRevision: candidate.actressRevision,
          finalMainName: 'Owner',
          replacementMainNames: []
        }),
      /名称「Third-party Name」已被其他演员使用/
    )
    assert.ok(getActressDetail(ownerId))
    assert.ok(getActressDetail(targetId))
    assert.equal(workflow.countPendingScrapes(), 1)
  })

  it('rejects the whole merge when the pending scrape also conflicts with a third actress', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    const thirdId = createActress('Third')
    editActress(ownerId, { aliases: ['Pair Collision'] })
    editActress(thirdId, { aliases: ['Third Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['aliases'],
      applicableFields: ['aliases'],
      mode: 'replace',
      result: { aliases: ['Pair Collision', 'Third Collision'] },
      warnings: [],
      resources: []
    })
    const group = workflow
      .listConflictGroups()
      .find((item) => item.normalizedName === 'paircollision')!
    const candidate = group.candidates[0]

    assert.match(group.mergePairs?.[0].blockedReason ?? '', /Third Collision/)

    assert.throws(
      () =>
        workflow.resolveConflict({
          kind: 'mergeActresses',
          snapshot: decisionSnapshot(group),
          pendingId: candidate.pendingId,
          keepActressId: ownerId,
          keepActressRevision: group.currentOwner!.revision,
          mergeActressId: targetId,
          mergeActressRevision: candidate.actressRevision,
          finalMainName: 'Owner',
          replacementMainNames: []
        }),
      /名称「Third Collision」还与第三位演员冲突/
    )
    assert.ok(getActressDetail(ownerId))
    assert.ok(getActressDetail(targetId))
    assert.equal(workflow.countPendingScrapes(), 1)
  })

  it('rejects merging a persisted name claimed by a third actress pending scrape', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    const thirdId = createActress('Third')
    editActress(ownerId, { aliases: ['Pair Collision'] })
    editActress(targetId, { aliases: ['Future Conflict'] })
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['aliases'],
      applicableFields: ['aliases'],
      mode: 'replace',
      result: { aliases: ['Pair Collision'] },
      warnings: [],
      resources: []
    })
    workflow.processPreparedScrape({
      actressId: thirdId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Third',
      selectedFields: ['aliases'],
      applicableFields: ['aliases'],
      mode: 'replace',
      result: { aliases: ['Future Conflict'] },
      warnings: [],
      resources: []
    })
    const group = workflow
      .listConflictGroups()
      .find((item) => item.normalizedName === 'paircollision')!
    const candidate = group.candidates.find((item) => item.actressId === targetId)!

    assert.throws(
      () =>
        workflow.resolveConflict({
          kind: 'mergeActresses',
          snapshot: decisionSnapshot(group),
          pendingId: candidate.pendingId,
          keepActressId: ownerId,
          keepActressRevision: group.currentOwner!.revision,
          mergeActressId: targetId,
          mergeActressRevision: candidate.actressRevision,
          finalMainName: 'Owner',
          replacementMainNames: []
        }),
      /名称「Future Conflict」还与第三位演员的待确认结果冲突/
    )
    assert.ok(getActressDetail(ownerId))
    assert.ok(getActressDetail(targetId))
    assert.ok(getActressDetail(thirdId))
    assert.equal(workflow.countPendingScrapes(), 2)
  })

  it('returns stale without merging when either actress changed after confirmation was shown', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    editActress(ownerId, { aliases: ['Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['aliases'],
      applicableFields: ['aliases'],
      mode: 'replace',
      result: { aliases: ['Collision'] },
      warnings: [],
      resources: []
    })
    const group = workflow.listConflictGroups()[0]
    const candidate = group.candidates[0]
    editActress(ownerId, { profile_summary: 'Changed after the merge dialog opened' })

    assert.deepEqual(
      workflow.resolveConflict({
        kind: 'mergeActresses',
        snapshot: decisionSnapshot(group),
        pendingId: candidate.pendingId,
        keepActressId: ownerId,
        keepActressRevision: group.currentOwner!.revision,
        mergeActressId: targetId,
        mergeActressRevision: candidate.actressRevision,
        finalMainName: 'Owner',
        replacementMainNames: []
      }),
      { status: 'stale', message: '数据已变化，请刷新后重新确认' }
    )
    assert.equal(getActressDetail(ownerId)?.profile_summary, 'Changed after the merge dialog opened')
    assert.ok(getActressDetail(targetId))
    assert.equal(workflow.countPendingScrapes(), 1)
  })

  it('rolls back the actress merge when pending reassociation fails', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    editActress(ownerId, { aliases: ['Collision'] })
    editActress(targetId, { birth_date: '1990-01-01' })
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['aliases'],
      applicableFields: ['aliases'],
      mode: 'replace',
      result: { aliases: ['Collision'] },
      warnings: [],
      resources: []
    })
    const group = workflow.listConflictGroups()[0]
    const candidate = group.candidates[0]
    getDb().exec(`
      CREATE TRIGGER fail_pending_merge_reassociation
      BEFORE UPDATE OF target_actress_revision ON pending_actress_scrapes
      BEGIN
        SELECT RAISE(ABORT, 'forced pending reassociation failure');
      END;
    `)

    assert.throws(
      () =>
        workflow.resolveConflict({
          kind: 'mergeActresses',
          snapshot: decisionSnapshot(group),
          pendingId: candidate.pendingId,
          keepActressId: ownerId,
          keepActressRevision: group.currentOwner!.revision,
          mergeActressId: targetId,
          mergeActressRevision: candidate.actressRevision,
          finalMainName: 'Owner',
          replacementMainNames: []
        }),
      /forced pending reassociation failure/
    )
    assert.equal(getActressDetail(ownerId)?.birth_date, null)
    assert.equal(getActressDetail(targetId)?.birth_date, '1990-01-01')
    assert.equal(findActressByNameOrAlias('Owner'), ownerId)
    assert.equal(findActressByNameOrAlias('Target'), targetId)
    assert.equal(workflow.listConflictGroups()[0].candidates[0].actressId, targetId)
  })

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

  it('previews and applies an assigned conflicting alias in a fill-empty alias collection', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    editActress(ownerId, { aliases: ['Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    assert.equal(
      workflow.processPreparedScrape({
        actressId: targetId,
        plugin: { name: 'Fixture Source', source: 'builtin' },
        queryName: 'Target',
        selectedFields: ['aliases'],
        applicableFields: ['aliases'],
        mode: 'fillEmpty',
        result: { aliases: ['Collision', 'Other Alias'] },
        warnings: [],
        resources: []
      }).status,
      'pending'
    )
    const group = workflow.listConflictGroups()[0]
    const candidate = group.candidates[0]

    assert.deepEqual(
      candidate.fieldImpacts.find((impact) => impact.field === 'aliases')?.nextValue,
      ['Other Alias']
    )
    assert.deepEqual(
      candidate.fieldImpactsWhenAssignedToCandidate.find(
        (impact) => impact.field === 'aliases'
      )?.nextValue,
      ['Collision', 'Other Alias']
    )

    assert.deepEqual(
      workflow.resolveConflict({
        kind: 'assignToCurrentActress',
        snapshot: decisionSnapshot(group),
        pendingId: candidate.pendingId,
        replacementMainNames: []
      }),
      { status: 'success', remainingPending: 0 }
    )
    assert.deepEqual(getActressDetail(targetId)?.aliases, ['Collision', 'Other Alias'])
  })

  it('keeps earlier ownership decisions in the final fill-empty alias preview and apply', () => {
    const firstOwnerId = createActress('First Owner')
    const secondOwnerId = createActress('Second Owner')
    const targetId = createActress('Target')
    editActress(firstOwnerId, { aliases: ['First Collision'] })
    editActress(secondOwnerId, { aliases: ['Second Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['aliases'],
      applicableFields: ['aliases'],
      mode: 'fillEmpty',
      result: { aliases: ['First Collision', 'Second Collision', 'Other Alias'] },
      warnings: [],
      resources: []
    })

    const firstGroup = workflow
      .listConflictGroups()
      .find((item) => item.normalizedName === 'firstcollision')!
    assert.deepEqual(
      workflow.resolveConflict({
        kind: 'assignToCurrentActress',
        snapshot: decisionSnapshot(firstGroup),
        pendingId: firstGroup.candidates[0].pendingId,
        replacementMainNames: []
      }),
      { status: 'success', remainingPending: 1 }
    )
    assert.deepEqual(getActressDetail(targetId)?.aliases, ['First Collision'])

    const secondGroup = workflow
      .listConflictGroups()
      .find((item) => item.normalizedName === 'secondcollision')!
    const candidate = secondGroup.candidates[0]
    assert.deepEqual(
      candidate.fieldImpactsWhenAssignedToCandidate.find(
        (impact) => impact.field === 'aliases'
      )?.nextValue,
      ['First Collision', 'Second Collision', 'Other Alias']
    )
    assert.deepEqual(
      workflow.resolveConflict({
        kind: 'assignToCurrentActress',
        snapshot: decisionSnapshot(secondGroup),
        pendingId: candidate.pendingId,
        replacementMainNames: []
      }),
      { status: 'success', remainingPending: 0 }
    )
    assert.deepEqual(getActressDetail(targetId)?.aliases.sort(), [
      'First Collision',
      'Other Alias',
      'Second Collision'
    ])
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

  it('removes an illegal normalized name from the whole group and applies unlocked profiles', () => {
    const ownerId = createActress('Owner')
    const firstTargetId = createActress('First Target')
    const secondTargetId = createActress('Second Target')
    editActress(ownerId, { aliases: ['作品一覧'] })
    const workflow = new ActressIdentityConflictWorkflow()
    for (const [actressId, birthDate] of [
      [firstTargetId, '1991-01-01'],
      [secondTargetId, '1992-02-02']
    ] as const) {
      workflow.processPreparedScrape({
        actressId,
        plugin: { name: 'Fixture Source', source: 'builtin' },
        queryName: getActressDetail(actressId)?.main_name ?? '',
        selectedFields: ['birthDate', 'aliases'],
        applicableFields: ['birthDate', 'aliases'],
        mode: 'replace',
        result: { birthDate, aliases: ['作品一覧'] },
        warnings: [],
        resources: []
      })
    }
    const group = workflow.listConflictGroups()[0]

    const outcome = workflow.resolveConflict({
      kind: 'markIllegalName',
      snapshot: decisionSnapshot(group),
      replacementMainNames: []
    })

    assert.deepEqual(outcome, { status: 'success', remainingPending: 0 })
    assert.deepEqual(getActressDetail(ownerId)?.aliases, [])
    assert.equal(findActressByNameOrAlias('作品一覧'), null)
    assert.equal(getActressDetail(firstTargetId)?.birth_date, '1991-01-01')
    assert.equal(getActressDetail(secondTargetId)?.birth_date, '1992-02-02')
    assert.deepEqual(getActressDetail(firstTargetId)?.aliases, [])
    assert.deepEqual(getActressDetail(secondTargetId)?.aliases, [])
    assert.deepEqual(workflow.listConflictGroups(), [])
  })

  it('requires a valid replacement for every main-name claimant before illegal-name removal', () => {
    const firstClaimantId = createActress('作品一覧')
    const secondClaimantId = createActress('Second Claimant')
    const occupiedId = createActress('Occupied Name')
    const targetId = createActress('Target')
    const db = getDb()
    db.prepare('DELETE FROM actress_name_ownership WHERE normalized_name IN (?, ?)').run(
      '作品一覧',
      'secondclaimant'
    )
    db.prepare('UPDATE actresses SET main_name = ? WHERE id = ?').run(
      '作 品 一 覧',
      secondClaimantId
    )
    db.prepare("UPDATE actress_names SET name = ? WHERE actress_id = ? AND type = 'main'").run(
      '作 品 一 覧',
      secondClaimantId
    )
    const insertClaim = db.prepare(
      `INSERT INTO pending_actress_name_claims
         (normalized_name, actress_id, name, type, is_primary)
       VALUES (?, ?, ?, 'main', 1)`
    )
    insertClaim.run('作品一覧', firstClaimantId, '作品一覧')
    insertClaim.run('作品一覧', secondClaimantId, '作 品 一 覧')

    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['birthDate', 'aliases'],
      applicableFields: ['birthDate', 'aliases'],
      mode: 'replace',
      result: { birthDate: '1993-03-03', aliases: ['作品一覧'] },
      warnings: [],
      resources: []
    })
    const group = workflow.listConflictGroups()[0]

    assert.throws(
      () =>
        workflow.resolveConflict({
          kind: 'markIllegalName',
          snapshot: decisionSnapshot(group),
          replacementMainNames: [
            { actressId: firstClaimantId, mainName: 'First Replacement' }
          ]
        }),
      /必须提供替代主名/
    )
    assert.throws(
      () =>
        workflow.resolveConflict({
          kind: 'markIllegalName',
          snapshot: decisionSnapshot(group),
          replacementMainNames: [
            { actressId: firstClaimantId, mainName: 'First Replacement' },
            { actressId: secondClaimantId, mainName: 'Occupied Name' }
          ]
        }),
      /已被其他演员使用/
    )
    assert.equal(getActressDetail(firstClaimantId)?.main_name, '作品一覧')
    assert.equal(getActressDetail(secondClaimantId)?.main_name, '作 品 一 覧')
    assert.equal(getActressDetail(targetId)?.birth_date, null)
    assert.equal(findActressByNameOrAlias('作品一覧'), null)

    assert.deepEqual(
      workflow.resolveConflict({
        kind: 'markIllegalName',
        snapshot: decisionSnapshot(group),
        replacementMainNames: [
          { actressId: firstClaimantId, mainName: 'First Replacement' },
          { actressId: secondClaimantId, mainName: 'Second Replacement' }
        ]
      }),
      { status: 'success', remainingPending: 0 }
    )
    assert.equal(getActressDetail(firstClaimantId)?.main_name, 'First Replacement')
    assert.equal(getActressDetail(secondClaimantId)?.main_name, 'Second Replacement')
    assert.equal(getActressDetail(occupiedId)?.main_name, 'Occupied Name')
    assert.equal(getActressDetail(targetId)?.birth_date, '1993-03-03')
  })

  it('validates illegal-name replacement main names against the live conflict snapshot', () => {
    const ownerId = createActress('作品一覧')
    createActress('Occupied Name')
    const targetId = createActress('Target')
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['aliases'],
      applicableFields: ['aliases'],
      mode: 'replace',
      result: { aliases: ['作品一覧'] },
      warnings: [],
      resources: []
    })
    const group = workflow.listConflictGroups()[0]
    const validate = workflow.validateIllegalNameReplacements.bind(workflow)

    assert.deepEqual(
      validate({ snapshot: decisionSnapshot(group), replacementMainNames: [] }),
      {
        status: 'invalid',
        errors: [{ actressId: ownerId, message: '请填写替代主名' }]
      }
    )
    assert.deepEqual(
      validate({
        snapshot: decisionSnapshot(group),
        replacementMainNames: [],
        destinationOwnerActressId: ownerId
      }),
      { status: 'valid' }
    )
    assert.deepEqual(
      validate({
        snapshot: decisionSnapshot(group),
        replacementMainNames: [{ actressId: ownerId, mainName: 'Occupied Name' }]
      }),
      {
        status: 'invalid',
        errors: [{ actressId: ownerId, message: '名称「Occupied Name」已被其他演员使用' }]
      }
    )
    assert.deepEqual(
      validate({
        snapshot: decisionSnapshot(group),
        replacementMainNames: [{ actressId: ownerId, mainName: 'Owner Replacement' }]
      }),
      { status: 'valid' }
    )

    editActress(targetId, { birth_date: '2000-01-01' })
    assert.deepEqual(
      validate({
        snapshot: decisionSnapshot(group),
        replacementMainNames: [{ actressId: ownerId, mainName: 'Owner Replacement' }]
      }),
      { status: 'stale', message: '数据已变化，请刷新后重新确认' }
    )
  })

  it('does not reconcile newly active conflicts while rejecting a stale illegal-name decision', () => {
    const ownerId = createActress('Owner')
    const targetId = createActress('Target')
    editActress(ownerId, { aliases: ['Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['aliases'],
      applicableFields: ['aliases'],
      mode: 'replace',
      result: { aliases: ['Collision', 'Later Collision'] },
      warnings: [],
      resources: []
    })
    const group = workflow
      .listConflictGroups()
      .find((item) => item.normalizedName === 'collision')!
    const snapshot = decisionSnapshot(group)
    const pendingId = group.candidates[0].pendingId
    createActress('Later Collision')
    const db = getDb()
    const readPendingState = (): { revision: number; conflictCount: number } => ({
      revision: (
        db.prepare('SELECT revision FROM pending_actress_scrapes WHERE id = ?').get(pendingId) as {
          revision: number
        }
      ).revision,
      conflictCount: (
        db
          .prepare(
            'SELECT COUNT(*) AS total FROM pending_actress_scrape_conflicts WHERE pending_scrape_id = ?'
          )
          .get(pendingId) as { total: number }
      ).total
    })
    const before = readPendingState()

    assert.deepEqual(
      workflow.validateIllegalNameReplacements({ snapshot, replacementMainNames: [] }),
      { status: 'stale', message: '数据已变化，请刷新后重新确认' }
    )
    assert.deepEqual(readPendingState(), before)
    assert.deepEqual(
      workflow.resolveConflict({
        kind: 'markIllegalName',
        snapshot,
        replacementMainNames: []
      }),
      { status: 'stale', message: '数据已变化，请刷新后重新确认' }
    )
    assert.deepEqual(readPendingState(), before)
  })

  it('removes only the current illegal group and does not remember a blacklist rule', () => {
    const illegalOwnerId = createActress('Illegal Owner')
    const otherOwnerId = createActress('Other Owner')
    const blockedTargetId = createActress('Blocked Target')
    editActress(illegalOwnerId, { aliases: ['作品一覧'] })
    editActress(otherOwnerId, { aliases: ['Other Collision'] })
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: blockedTargetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Blocked Target',
      selectedFields: ['birthDate', 'aliases'],
      applicableFields: ['birthDate', 'aliases'],
      mode: 'replace',
      result: { birthDate: '1993-03-03', aliases: ['作品一覧', 'Other Collision'] },
      warnings: [],
      resources: []
    })
    const illegalGroup = workflow
      .listConflictGroups()
      .find((group) => group.normalizedName === '作品一覧')!

    assert.deepEqual(
      workflow.resolveConflict({
        kind: 'markIllegalName',
        snapshot: decisionSnapshot(illegalGroup),
        replacementMainNames: []
      }),
      { status: 'success', remainingPending: 1 }
    )
    const remainingGroup = workflow.listConflictGroups()[0]
    assert.equal(remainingGroup.normalizedName, 'othercollision')
    assert.deepEqual(remainingGroup.candidates[0].result.aliases, ['Other Collision'])
    assert.equal(getActressDetail(blockedTargetId)?.birth_date, null)
    assert.deepEqual(getActressDetail(illegalOwnerId)?.aliases, [])

    const firstFutureTargetId = createActress('First Future Target')
    assert.equal(
      workflow.processPreparedScrape({
        actressId: firstFutureTargetId,
        plugin: { name: 'Fixture Source', source: 'builtin' },
        queryName: 'First Future Target',
        selectedFields: ['aliases'],
        applicableFields: ['aliases'],
        mode: 'replace',
        result: { aliases: ['作品一覧'] },
        warnings: [],
        resources: []
      }).status,
      'success'
    )
    const secondFutureTargetId = createActress('Second Future Target')
    assert.equal(
      workflow.processPreparedScrape({
        actressId: secondFutureTargetId,
        plugin: { name: 'Fixture Source', source: 'builtin' },
        queryName: 'Second Future Target',
        selectedFields: ['aliases'],
        applicableFields: ['aliases'],
        mode: 'replace',
        result: { aliases: ['作品一覧'] },
        warnings: [],
        resources: []
      }).status,
      'pending'
    )
    const recreatedGroup = workflow
      .listConflictGroups()
      .find((group) => group.normalizedName === '作品一覧')!
    assert.equal(recreatedGroup.currentOwner?.actressId, firstFutureTargetId)
    assert.deepEqual(
      recreatedGroup.candidates.map((candidate) => candidate.actressId),
      [secondFutureTargetId]
    )
  })

  it('applies a result when its other recorded conflict has already become inactive', () => {
    const illegalOwnerId = createActress('Illegal Owner')
    const resolvedOwnerId = createActress('Resolved Owner')
    const targetId = createActress('Target')
    editActress(illegalOwnerId, { aliases: ['作品一覧'] })
    editActress(resolvedOwnerId, { aliases: ['Resolved Elsewhere'] })
    const workflow = new ActressIdentityConflictWorkflow()
    workflow.processPreparedScrape({
      actressId: targetId,
      plugin: { name: 'Fixture Source', source: 'builtin' },
      queryName: 'Target',
      selectedFields: ['birthDate', 'aliases'],
      applicableFields: ['birthDate', 'aliases'],
      mode: 'replace',
      result: {
        birthDate: '1994-04-04',
        aliases: ['作品一覧', 'Resolved Elsewhere']
      },
      warnings: [],
      resources: []
    })
    const illegalGroup = workflow
      .listConflictGroups()
      .find((group) => group.normalizedName === '作品一覧')!
    editActress(resolvedOwnerId, { aliases: [] })

    assert.deepEqual(
      workflow.resolveConflict({
        kind: 'markIllegalName',
        snapshot: decisionSnapshot(illegalGroup),
        replacementMainNames: []
      }),
      { status: 'success', remainingPending: 0 }
    )
    assert.equal(getActressDetail(targetId)?.birth_date, '1994-04-04')
    assert.deepEqual(getActressDetail(targetId)?.aliases, ['Resolved Elsewhere'])
    assert.deepEqual(workflow.listConflictGroups(), [])
  })

  for (const failurePoint of [
    'name deletion',
    'main replacement',
    'profile application',
    'pending cleanup'
  ] as const) {
    it(`rolls back illegal-name handling when ${failurePoint} fails`, () => {
      const ownerId = createActress(failurePoint === 'main replacement' ? '作品一覧' : 'Owner')
      const targetId = createActress('Target')
      if (failurePoint !== 'main replacement') {
        editActress(ownerId, { aliases: ['作品一覧'] })
      }
      const workflow = new ActressIdentityConflictWorkflow()
      workflow.processPreparedScrape({
        actressId: targetId,
        plugin: { name: 'Fixture Source', source: 'builtin' },
        queryName: 'Target',
        selectedFields: ['birthDate', 'aliases'],
        applicableFields: ['birthDate', 'aliases'],
        mode: 'replace',
        result: { birthDate: '1993-03-03', aliases: ['作品一覧'] },
        warnings: [],
        resources: []
      })
      const group = workflow.listConflictGroups()[0]
      const pendingId = group.candidates[0].pendingId
      const db = getDb()
      if (failurePoint === 'name deletion') {
        db.exec(`
          CREATE TRIGGER fail_illegal_name_delete
          BEFORE DELETE ON actress_names
          WHEN normalize_actress_name(OLD.name) = '作品一覧'
          BEGIN
            SELECT RAISE(ABORT, 'forced name deletion failure');
          END;
        `)
      } else if (failurePoint === 'main replacement') {
        db.exec(`
          CREATE TRIGGER fail_illegal_main_replacement
          BEFORE UPDATE OF main_name ON actresses
          WHEN OLD.id = ${ownerId}
          BEGIN
            SELECT RAISE(ABORT, 'forced main replacement failure');
          END;
        `)
      } else if (failurePoint === 'profile application') {
        db.exec(`
          CREATE TRIGGER fail_illegal_profile_apply
          BEFORE UPDATE OF birth_date ON actresses
          WHEN OLD.id = ${targetId}
          BEGIN
            SELECT RAISE(ABORT, 'forced profile application failure');
          END;
        `)
      } else {
        db.exec(`
          CREATE TRIGGER fail_illegal_pending_cleanup
          BEFORE DELETE ON pending_actress_scrapes
          WHEN OLD.id = ${pendingId}
          BEGIN
            SELECT RAISE(ABORT, 'forced pending cleanup failure');
          END;
        `)
      }

      assert.throws(
        () =>
          workflow.resolveConflict({
            kind: 'markIllegalName',
            snapshot: decisionSnapshot(group),
            replacementMainNames:
              failurePoint === 'main replacement'
                ? [{ actressId: ownerId, mainName: 'Owner Replacement' }]
                : []
          }),
        /forced/
      )
      assert.equal(
        getActressDetail(ownerId)?.main_name,
        failurePoint === 'main replacement' ? '作品一覧' : 'Owner'
      )
      if (failurePoint !== 'main replacement') {
        assert.deepEqual(getActressDetail(ownerId)?.aliases, ['作品一覧'])
      }
      assert.equal(findActressByNameOrAlias('作品一覧'), ownerId)
      assert.equal(getActressDetail(targetId)?.birth_date, null)
      assert.equal(getActressDetail(targetId)?.scraped_status, 0)
      assert.equal(workflow.countPendingScrapes(), 1)
      assert.equal(workflow.listConflictGroups()[0].normalizedName, '作品一覧')
    })
  }

  it('keeps the whole illegal-name group pending when any resource preparation fails', () => {
    const ownerId = createActress('Owner')
    const firstTargetId = createActress('First Target')
    const secondTargetId = createActress('Second Target')
    editActress(ownerId, { aliases: ['作品一覧'] })
    const workflow = new ActressIdentityConflictWorkflow()
    for (const actressId of [firstTargetId, secondTargetId]) {
      workflow.processPreparedScrape({
        actressId,
        plugin: { name: 'Fixture Source', source: 'builtin' },
        queryName: getActressDetail(actressId)?.main_name ?? '',
        selectedFields: ['avatar', 'birthDate', 'aliases'],
        applicableFields: ['avatar', 'birthDate', 'aliases'],
        mode: 'replace',
        result: {
          avatarUrl: `https://example.test/${actressId}.jpg`,
          birthDate: '1993-03-03',
          aliases: ['作品一覧']
        },
        warnings: [],
        resources: [
          {
            field: 'avatar',
            position: 0,
            remoteUrl: `https://example.test/${actressId}.jpg`,
            data: MINIMAL_JPEG
          }
        ]
      })
    }
    const group = workflow.listConflictGroups()[0]
    const stagedPaths = group.candidates.map((candidate) =>
      path.join(tempRoot, 'media_assets', candidate.resources[0].stagedPath)
    )
    fs.writeFileSync(stagedPaths[1], Buffer.from('broken image'))

    assert.throws(
      () =>
        workflow.resolveConflict({
          kind: 'markIllegalName',
          snapshot: decisionSnapshot(group),
          replacementMainNames: []
        }),
      /暂存资源不可用/
    )
    assert.deepEqual(getActressDetail(ownerId)?.aliases, ['作品一覧'])
    assert.equal(findActressByNameOrAlias('作品一覧'), ownerId)
    assert.equal(getActressDetail(firstTargetId)?.birth_date, null)
    assert.equal(getActressDetail(firstTargetId)?.avatar_path, null)
    assert.equal(getActressDetail(secondTargetId)?.birth_date, null)
    assert.equal(getActressDetail(secondTargetId)?.avatar_path, null)
    assert.equal(workflow.countPendingScrapes(), 2)
    assert.equal(fs.existsSync(stagedPaths[0]), true)
    assert.equal(fs.existsSync(stagedPaths[1]), true)
    const avatarDirectory = path.join(tempRoot, 'media_assets', 'avatars')
    assert.deepEqual(
      fs.existsSync(avatarDirectory) ? fs.readdirSync(avatarDirectory) : [],
      []
    )
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
    assert.deepEqual(workflow.getConflictReviewSummary(), {
      groupCount: 1,
      conflictGroupCount: 0,
      applicableGroupCount: 1,
      pendingScrapeCount: 1,
      pendingNameClaimGroupCount: 0
    })
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

    createActressMaintenanceService().deleteActresses({
      ids: [targetId],
      mode: 'only-unlinked'
    })

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


function createMaintenanceFixture(): ActressIdentityConflictWorkflow {
  const owner = createActress('Maintenance Owner')
  editActress(owner, { aliases: ['Maintenance Collision'] })
  const target = createActress('Maintenance Target')
  const workflow = new ActressIdentityConflictWorkflow()
  workflow.processPreparedScrape({ actressId: target, plugin: {name:'Fixture',source:'builtin'},
    queryName:'Maintenance Target',selectedFields:['aliases'],applicableFields:['aliases'],mode:'replace',
    result:{aliases:['Maintenance Collision']},warnings:[],resources:[] })
  return workflow
}

it('reuses maintenance only until local writes, schema changes or external commits',()=>{
  const workflow=createMaintenanceFixture(), db=getDb()
  const original=db.prepare.bind(db)
  let scans=0
  db.prepare=((sql:string)=>{if(sql.includes('SELECT id, actress_id, applicable_fields_json, result_json'))scans++;return original(sql)}) as typeof db.prepare
  let other:Database.Database|undefined
  try{
    const expected=workflow.getConflictReviewSummary()
    assert.equal(scans,1)
    assert.deepEqual(workflow.getConflictReviewSummary(),expected);assert.equal(scans,1)
    db.exec('UPDATE actresses SET revision=revision')
    assert.deepEqual(workflow.getConflictReviewSummary(),expected);assert.equal(scans,2)
    db.exec('CREATE TABLE maintenance_schema_probe(id INTEGER)')
    assert.deepEqual(workflow.getConflictReviewSummary(),expected);assert.equal(scans,3)
    other=new Database(path.join(tempRoot,'library.db'))
    other.exec('DELETE FROM pending_actress_scrape_conflicts')
    assert.deepEqual(workflow.getConflictReviewSummary(),expected);assert.equal(scans,4)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM pending_actress_scrape_conflicts').get() as {n:number}).n,1)
    assert.deepEqual(workflow.getConflictReviewSummary(),expected);assert.equal(scans,5,'a repair requires a subsequent no-write pass')
    assert.deepEqual(workflow.getConflictReviewSummary(),expected);assert.equal(scans,5)
  }finally{other?.close();db.prepare=original}
})

it('does not publish rolled-back maintenance or skip checks inside a caller transaction',()=>{
  const workflow=createMaintenanceFixture(),db=getDb()
  workflow.getConflictReviewSummary()
  db.exec('DELETE FROM pending_actress_scrape_conflicts')
  const before=(db.prepare('SELECT revision FROM pending_actress_scrapes').get() as {revision:number}).revision
  assert.throws(()=>db.transaction(()=>{
    workflow.getConflictReviewSummary()
    assert.equal((db.prepare('SELECT revision FROM pending_actress_scrapes').get() as {revision:number}).revision,before+1)
    db.exec('DELETE FROM pending_actress_scrape_conflicts')
    workflow.getConflictReviewSummary()
    assert.equal((db.prepare('SELECT revision FROM pending_actress_scrapes').get() as {revision:number}).revision,before+2)
    throw new Error('rollback maintenance')
  })(),/rollback maintenance/)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM pending_actress_scrape_conflicts').get() as {n:number}).n,0)
  assert.equal(workflow.getConflictReviewSummary().groupCount,1)
  assert.equal((db.prepare('SELECT revision FROM pending_actress_scrapes').get() as {revision:number}).revision,before+1)
})

it('retries failed maintenance and invalidates after reopening the same catalog',()=>{
  const workflow=createMaintenanceFixture(),db=getDb()
  workflow.getConflictReviewSummary()
  db.exec('DELETE FROM pending_actress_scrape_conflicts')
  const original=db.prepare.bind(db)
  db.prepare=((sql:string)=>{if(sql.includes('SELECT id, actress_id, applicable_fields_json, result_json'))throw new Error('injected read failure');return original(sql)}) as typeof db.prepare
  try{assert.throws(()=>workflow.getConflictReviewSummary(),/injected read failure/)}finally{db.prepare=original}
  assert.equal(workflow.getConflictReviewSummary().groupCount,1)
  closeDatabase()
  const other=new Database(path.join(tempRoot,'library.db'))
  try{other.exec('DELETE FROM pending_actress_scrape_conflicts')}finally{other.close()}
  const reopened=initDatabaseAtPath(path.join(tempRoot,'library.db'))
  assert.equal(workflow.getConflictReviewSummary().groupCount,1)
  assert.equal((reopened.prepare('SELECT COUNT(*) AS n FROM pending_actress_scrape_conflicts').get() as {n:number}).n,1)
})

it('does not publish a maintenance stamp if an external commit occurs during the check',()=>{
  const workflow=createMaintenanceFixture(),db=getDb()
  const other=new Database(path.join(tempRoot,'library.db'))
  const original=db.prepare.bind(db)
  let scans=0
  db.prepare=((sql:string)=>{
    if(sql.includes('SELECT id, actress_id, applicable_fields_json, result_json')){
      scans++
      if(scans===1)other.exec('UPDATE actresses SET revision=revision')
    }
    return original(sql)
  }) as typeof db.prepare
  try{
    const expected=workflow.getConflictReviewSummary()
    assert.equal(scans,1)
    assert.deepEqual(workflow.getConflictReviewSummary(),expected);assert.equal(scans,2)
    assert.deepEqual(workflow.getConflictReviewSummary(),expected);assert.equal(scans,2)
  }finally{db.prepare=original;other.close()}
})

it('rechecks earlier candidates after a later candidate introduces a new conflict',()=>{
  const workflow=createMaintenanceFixture(),db=getDb()
  db.exec(`DELETE FROM pending_actress_scrape_conflicts;
    UPDATE pending_actress_scrapes SET id=2;
    INSERT INTO pending_actress_scrapes(id,actress_id,target_actress_revision,plugin_name,plugin_source,query_name,selected_fields_json,applicable_fields_json,update_mode,result_json,warnings_json,created_at)
    SELECT 1,id,revision,'Fixture','builtin',main_name,'["aliases"]','["aliases"]','replace','{"aliases":["Maintenance Collision"]}','[]','2026'
    FROM actresses WHERE main_name='Maintenance Owner';`)
  workflow.getConflictReviewSummary()
  const ids=()=>db.prepare('SELECT pending_scrape_id AS id FROM pending_actress_scrape_conflicts ORDER BY pending_scrape_id').all()
  assert.deepEqual(ids(),[{id:2}],'the owner was visited before the new foreign conflict existed')
  workflow.getConflictReviewSummary()
  assert.deepEqual(ids(),[{id:1},{id:2}],'the next check must revisit the earlier owner')
})

it('bounds a 10k legacy-claim queue without hydrating candidates after maintenance',()=>{
  const id=createActress('Claim fixture'),db=getDb(),workflow=new ActressIdentityConflictWorkflow()
  db.prepare(`WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
    INSERT INTO pending_actress_name_claims(normalized_name,actress_id,name,type)
    SELECT 'claim-'||printf('%05d',x),?,'Claim-'||printf('%05d',x),'alias' FROM n`).run(id)
  workflow.getConflictReviewSummary()
  const original=db.prepare.bind(db)
  db.prepare=((sql:string)=>{assert.ok(!sql.includes('result_json') && !sql.includes('pending_actress_scrape_resources'),'hot page must not hydrate JSON/resources');return original(sql)}) as typeof db.prepare
  try{
    const page=workflow.pageConflictQueue({limit:100,anchorName:'claim-09999'})
    assert.equal(page.total,10000);assert.equal(page.offset,9900);assert.equal(page.items.length,100)
    assert.deepEqual(page.items[98],{normalizedName:'claim-09999',displayName:'Claim-09999',status:'conflict',candidateCount:0,pendingNameClaimCount:1,avatarPath:null})
    assert.ok(Buffer.byteLength(JSON.stringify(page))<20000)
    for(const query of [{limit:101},{offset:-1},{offset:Number.MAX_SAFE_INTEGER+1},{anchorName:''}])assert.throws(()=>workflow.pageConflictQueue(query),/Invalid/)
  }finally{db.prepare=original}
  db.exec('DELETE FROM pending_actress_name_claims')
  assert.deepEqual(workflow.pageConflictQueue({offset:9900}),{items:[],total:0,offset:0})
})

it('does not hydrate unrelated candidate results for a selected name group',()=>{
  const workflow=createMaintenanceFixture(),db=getDb()
  workflow.getConflictReviewSummary()
  const unrelated=createActress('Unrelated invalid snapshot')
  db.prepare(`INSERT INTO pending_actress_scrapes(actress_id,target_actress_revision,plugin_name,plugin_source,query_name,selected_fields_json,applicable_fields_json,update_mode,result_json,warnings_json,created_at)
    VALUES(?,1,'Fixture','builtin','Unrelated','[]','[]','replace','{}','not valid JSON','2026')`).run(unrelated)
  assert.equal(workflow.getConflictGroup('maintenancecollision')?.candidates.length,1)
  assert.equal(workflow.getConflictGroup('missing'),null)
  assert.throws(()=>workflow.getConflictGroup(''),/Invalid/)
})

it('sorts full conflict names before truncating display captions and preserves exact anchors',()=>{
  const owner=createActress('Long-name claimant'),db=getDb(),workflow=new ActressIdentityConflictWorkflow()
  const prefix='😀'.repeat(128)
  for(const suffix of ['乙','甲'])db.prepare("INSERT INTO pending_actress_name_claims(normalized_name,actress_id,name,type) VALUES(?,?,?,'alias')").run(prefix+suffix,owner,prefix+suffix)
  const expected=workflow.listConflictGroups(false)
  for(const [rank,group] of expected.entries()){
    const page=workflow.pageConflictQueue({limit:1,anchorName:group.normalizedName})
    assert.equal(page.offset,rank)
    assert.equal(page.items[0].normalizedName,group.normalizedName)
    assert.equal(page.items[0].displayName,prefix+'…')
    assert.deepEqual(workflow.getConflictGroup(group.normalizedName),group)
  }
})

it('keeps legacy equal-caption order across pages and clamps missing anchors in a nonempty queue',()=>{
  const owner=createActress('Tie claimant'),db=getDb(),workflow=new ActressIdentityConflictWorkflow()
  for(const key of ['tie-b','tie-a'])db.prepare("INSERT INTO pending_actress_name_claims(normalized_name,actress_id,name,type) VALUES(?,?,'Same caption','alias')").run(key,owner)
  const legacy=workflow.listConflictGroups(false)
  assert.deepEqual(legacy.map(group=>group.normalizedName),['tie-a','tie-b'])
  assert.equal(workflow.pageConflictQueue({limit:1}).items[0].normalizedName,'tie-a')
  const last=workflow.pageConflictQueue({limit:1,offset:9999,anchorName:'missing'})
  assert.equal(last.offset,1);assert.equal(last.items[0].normalizedName,'tie-b')
})


it('bounds name normalization when merged actors have many third pending conflicts', () => {
  const db = getDb()
  const count = 100
  db.transaction(() => {
    db.exec(`
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < ${count + 1})
      INSERT INTO actresses(id, main_name) SELECT x, 'Actor-' || x FROM n;
      INSERT INTO actress_names(actress_id, name, type, source) SELECT id, main_name, 'main', 'manual' FROM actresses;
      INSERT INTO actress_name_ownership(normalized_name, actress_id) SELECT normalize_actress_name(main_name), id FROM actresses;
      INSERT INTO actress_names(actress_id, name, type, source)
        SELECT ${count + 1}, 'Collision-' || id, 'alias', 'manual' FROM actresses WHERE id <= ${count};
      INSERT INTO actress_name_ownership(normalized_name, actress_id)
        SELECT normalize_actress_name('Collision-' || id), ${count + 1} FROM actresses WHERE id <= ${count};
    `)
    const insert = db.prepare(`INSERT INTO pending_actress_scrapes
      (id, actress_id, target_actress_revision, plugin_name, plugin_source, query_name,
       selected_fields_json, applicable_fields_json, update_mode, result_json, warnings_json, created_at)
      VALUES (?, ?, 1, 'Fixture', 'builtin', ?, '["aliases"]', '["aliases"]', 'replace', ?, '[]', '2026')`)
    for (let id = 1; id <= count; id++) {
      insert.run(id, id, `Actor-${id}`, JSON.stringify({ aliases: [`Collision-${id}`] }))
    }
    db.exec(`INSERT INTO pending_actress_scrape_conflicts(pending_scrape_id, normalized_name, name, name_type)
      SELECT id, normalize_actress_name('Collision-' || id), 'Collision-' || id, 'alias' FROM pending_actress_scrapes`)
  })()
  db.exec('ANALYZE')
  const workflow = new ActressIdentityConflictWorkflow()
  workflow.getConflictReviewSummary()
  let normalizedCalls = 0
  db.function('normalize_actress_name', { deterministic: true }, (value: unknown) => {
    normalizedCalls++
    if (typeof value !== 'string') return null
    try { return normalizeActressName(value) } catch { return null }
  })
  const group = workflow.getConflictGroup(normalizeActressName('Collision-1'))!
  assert.equal(group.candidates[0].pendingId, 1)
  assert.match(group.mergePairs?.[0].blockedReason ?? '', /第三位演员的待确认结果/)
  assert.ok(normalizedCalls <= 5 * count, `Repeated normalization: ${normalizedCalls} for ${count} names`)
})
