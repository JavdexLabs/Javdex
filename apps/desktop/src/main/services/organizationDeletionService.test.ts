import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { classificationMaintenanceService } from './classificationMaintenanceService'
import {
  createOrganizationDeletionService,
  organizationDeletionService
} from './organizationDeletionService'

let tempRoot: string | null = null

function setup(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-organization-delete-'))
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
}

function createVideo(code: string): number {
  const videoId = Number(
    getDb()
      .prepare("INSERT INTO videos (code, title, summary) VALUES (?, 'Keep title', 'Keep metadata')")
      .run(code).lastInsertRowid
  )
  getDb()
    .prepare(
      `INSERT INTO library_video_memberships (library_id, video_id, discovery_key)
       VALUES (1, ?, ?)`
    )
    .run(videoId, videoId)
  return videoId
}

function assignOrganization(videoId: number, role: 'maker' | 'publisher', id: number): void {
  classificationMaintenanceService.assignVideoOrganization(videoId, role, { organizationId: id })
}

function addResource(videoId: number, key: string): void {
  getDb()
    .prepare(
      `INSERT INTO video_resources (
         library_id, video_id, kind, locator, resource_key, display_name
       ) VALUES (1, ?, 'web', ?, ?, 'Keep resource')`
    )
    .run(videoId, `https://example.com/${key}`, key)
}

afterEach(() => {
  closeDatabase()
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('organizationDeletionService', () => {
  it('removes only the selected role and recalculates its linked videos at execution time', () => {
    setup()
    const id = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Dual Role Studio',
      summary: 'Keep profile'
    })
    const makerVideoId = createVideo('ORGANIZATION-ROLE-MAKER-1')
    const publisherVideoId = createVideo('ORGANIZATION-ROLE-PUBLISHER')
    assignOrganization(makerVideoId, 'maker', id)
    assignOrganization(publisherVideoId, 'publisher', id)
    const seriesId = classificationMaintenanceService.createSeries({
      mainName: 'Owned Series',
      ownerOrganizationId: id
    })
    getDb().prepare('UPDATE organizations SET image_path = ? WHERE id = ?').run(
      'covers/dual-role.jpg',
      id
    )

    assert.deepEqual(organizationDeletionService.previewRoleRemoval(id, 'maker'), {
      id,
      role: 'maker',
      roleVideoCount: 1,
      remainingRoles: ['publisher'],
      canRemove: true
    })
    const secondMakerVideoId = createVideo('ORGANIZATION-ROLE-MAKER-2')
    assignOrganization(secondMakerVideoId, 'maker', id)
    const deletedImages: string[] = []
    const service = createOrganizationDeletionService({
      deleteStoredImage: (storedPath) => deletedImages.push(storedPath)
    })

    assert.deepEqual(service.removeRole(id, 'maker'), {
      id,
      role: 'maker',
      unlinkedVideoCount: 2,
      remainingRoles: ['publisher']
    })
    assert.deepEqual(
      getDb().prepare('SELECT maker_organization_id FROM videos WHERE id = ?').get(makerVideoId),
      { maker_organization_id: null }
    )
    assert.deepEqual(
      getDb()
        .prepare('SELECT publisher_organization_id FROM videos WHERE id = ?')
        .get(publisherVideoId),
      { publisher_organization_id: id }
    )
    assert.deepEqual(
      getDb().prepare('SELECT role FROM organization_roles WHERE organization_id = ?').all(id),
      [{ role: 'publisher' }]
    )
    assert.deepEqual(
      getDb().prepare('SELECT summary, image_path FROM organizations WHERE id = ?').get(id),
      { summary: 'Keep profile', image_path: 'covers/dual-role.jpg' }
    )
    assert.deepEqual(
      getDb().prepare('SELECT owner_organization_id FROM series WHERE id = ?').get(seriesId),
      { owner_organization_id: id }
    )
    assert.deepEqual(deletedImages, [])
  })

  it('rejects removing the final role and leaves all relations unchanged', () => {
    setup()
    const id = classificationMaintenanceService.createOrganization({
      role: 'publisher',
      mainName: 'Publisher Only'
    })
    const videoId = createVideo('ORGANIZATION-FINAL-ROLE')
    assignOrganization(videoId, 'publisher', id)

    assert.deepEqual(organizationDeletionService.previewRoleRemoval(id, 'publisher'), {
      id,
      role: 'publisher',
      roleVideoCount: 1,
      remainingRoles: [],
      canRemove: false
    })
    assert.throws(
      () => organizationDeletionService.removeRole(id, 'publisher'),
      /最后一个机构角色不能单独移除/
    )
    assert.ok(getDb().prepare('SELECT 1 FROM organizations WHERE id = ?').get(id))
    assert.deepEqual(
      getDb().prepare('SELECT publisher_organization_id FROM videos WHERE id = ?').get(videoId),
      { publisher_organization_id: id }
    )
  })

  it('blocks role removal and full deletion when they would rewrite a pending video', () => {
    setup()
    const id = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Pending Relations'
    })
    classificationMaintenanceService.assignVideoOrganization(
      createVideo('ADD-PUBLISHER-ROLE'),
      'publisher',
      { organizationId: id }
    )
    const videoId = createVideo('PENDING-RELATION')
    assignOrganization(videoId, 'maker', id)
    getDb().prepare(
      `INSERT INTO pending_video_scrapes (
         video_id, selected_fields_json, applicable_fields_json, update_mode,
         request_json, warnings_json, created_at, updated_at
       ) VALUES (?, '[]', '[]', 'replace', '{}', '[]', '2025-01-01', '2025-01-01')`
    ).run(videoId)

    assert.throws(() => organizationDeletionService.removeRole(id, 'maker'), /待确认.*刮削/)
    assert.throws(() => organizationDeletionService.deleteOrganization(id), /待确认.*刮削/)
    assert.deepEqual(
      getDb().prepare('SELECT maker_organization_id FROM videos WHERE id = ?').get(videoId),
      { maker_organization_id: id }
    )
  })

  it('fully deletes an organization and detaches every supported relation after a fresh preview', () => {
    setup()
    const id = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Delete Entire Studio'
    })
    const childId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Child Studio',
      parentOrganizationId: id
    })
    const seriesId = classificationMaintenanceService.createSeries({
      mainName: 'Delete Owner Series',
      aliases: ['Delete Owner Alias'],
      ownerOrganizationId: id
    })
    const makerVideoId = createVideo('ORGANIZATION-DELETE-MAKER')
    const publisherVideoId = createVideo('ORGANIZATION-DELETE-PUBLISHER')
    const bothVideoId = createVideo('ORGANIZATION-DELETE-BOTH')
    assignOrganization(makerVideoId, 'maker', id)
    assignOrganization(publisherVideoId, 'publisher', id)
    assignOrganization(bothVideoId, 'maker', id)
    assignOrganization(bothVideoId, 'publisher', id)
    addResource(makerVideoId, 'organization-delete-resource')
    getDb().prepare('UPDATE organizations SET image_path = ? WHERE id = ?').run(
      'covers/delete-entire.jpg',
      id
    )

    assert.deepEqual(organizationDeletionService.previewOrganization(id), {
      id,
      makerVideoCount: 2,
      publisherVideoCount: 2,
      directChildCount: 1,
      ownedSeriesCount: 1
    })
    const lateMakerVideoId = createVideo('ORGANIZATION-DELETE-LATE-MAKER')
    assignOrganization(lateMakerVideoId, 'maker', id)
    const deletedImages: string[] = []
    const service = createOrganizationDeletionService({
      deleteStoredImage: (storedPath) => {
        assert.equal(getDb().prepare('SELECT 1 FROM organizations WHERE id = ?').get(id), undefined)
        deletedImages.push(storedPath)
      }
    })

    assert.deepEqual(service.deleteOrganization(id), {
      id,
      unlinkedMakerVideoCount: 3,
      unlinkedPublisherVideoCount: 2,
      detachedChildCount: 1,
      detachedSeriesCount: 1,
      cleanupFailures: []
    })
    assert.deepEqual(
      getDb().prepare('SELECT title, summary, maker_organization_id FROM videos WHERE id = ?').get(makerVideoId),
      { title: 'Keep title', summary: 'Keep metadata', maker_organization_id: null }
    )
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS count FROM video_resources WHERE video_id = ?').get(
        makerVideoId
      ) as { count: number }).count,
      1
    )
    assert.deepEqual(
      getDb()
        .prepare('SELECT maker_organization_id, publisher_organization_id FROM videos WHERE id = ?')
        .get(bothVideoId),
      { maker_organization_id: null, publisher_organization_id: null }
    )
    assert.deepEqual(
      getDb().prepare('SELECT parent_organization_id FROM organizations WHERE id = ?').get(childId),
      { parent_organization_id: null }
    )
    assert.deepEqual(
      getDb().prepare('SELECT owner_organization_id FROM series WHERE id = ?').get(seriesId),
      { owner_organization_id: null }
    )
    assert.deepEqual(
      getDb()
        .prepare(
          'SELECT DISTINCT owner_organization_id FROM series_name_ownership WHERE series_id = ?'
        )
        .all(seriesId),
      [{ owner_organization_id: null }]
    )
    assert.deepEqual(deletedImages, ['covers/delete-entire.jpg'])
  })

  it('rejects full deletion when owned series names conflict in the unowned scope', () => {
    setup()
    const id = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Conflict Owner'
    })
    classificationMaintenanceService.createSeries({ mainName: 'Shared Series Name' })
    const ownedSeriesId = classificationMaintenanceService.createSeries({
      mainName: 'Shared Series Name',
      ownerOrganizationId: id
    })
    const videoId = createVideo('ORGANIZATION-CONFLICT')
    assignOrganization(videoId, 'maker', id)

    assert.throws(
      () => organizationDeletionService.deleteOrganization(id),
      /与未归属系列.*冲突；请先修改或合并冲突系列/
    )
    assert.ok(getDb().prepare('SELECT 1 FROM organizations WHERE id = ?').get(id))
    assert.deepEqual(
      getDb().prepare('SELECT owner_organization_id FROM series WHERE id = ?').get(ownedSeriesId),
      { owner_organization_id: id }
    )
    assert.deepEqual(
      getDb().prepare('SELECT maker_organization_id FROM videos WHERE id = ?').get(videoId),
      { maker_organization_id: id }
    )
  })

  it('rolls back full deletion relations and skips image cleanup when deletion fails', () => {
    setup()
    const id = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Rollback Organization'
    })
    const videoId = createVideo('ORGANIZATION-ROLLBACK')
    assignOrganization(videoId, 'maker', id)
    getDb().prepare('UPDATE organizations SET image_path = ? WHERE id = ?').run('locked.jpg', id)
    getDb().exec(`CREATE TRIGGER fail_organization_delete BEFORE DELETE ON organizations
      WHEN OLD.id = ${id} BEGIN SELECT RAISE(ABORT, 'forced organization delete failure'); END`)
    const deletedImages: string[] = []
    const service = createOrganizationDeletionService({
      deleteStoredImage: (storedPath) => deletedImages.push(storedPath)
    })

    assert.throws(() => service.deleteOrganization(id), /forced organization delete failure/)
    assert.deepEqual(
      getDb().prepare('SELECT maker_organization_id FROM videos WHERE id = ?').get(videoId),
      { maker_organization_id: id }
    )
    assert.ok(getDb().prepare('SELECT 1 FROM organizations WHERE id = ?').get(id))
    assert.deepEqual(deletedImages, [])
  })

  it('commits full deletion while reporting post-commit image cleanup failures', () => {
    setup()
    const id = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Cleanup Organization'
    })
    getDb().prepare('UPDATE organizations SET image_path = ? WHERE id = ?').run(
      'covers/cleanup-organization.jpg',
      id
    )
    const service = createOrganizationDeletionService({
      deleteStoredImage: () => {
        throw new Error('image locked')
      }
    })

    assert.deepEqual(service.deleteOrganization(id), {
      id,
      unlinkedMakerVideoCount: 0,
      unlinkedPublisherVideoCount: 0,
      detachedChildCount: 0,
      detachedSeriesCount: 0,
      cleanupFailures: [{ path: 'covers/cleanup-organization.jpg', error: 'image locked' }]
    })
    assert.equal(getDb().prepare('SELECT 1 FROM organizations WHERE id = ?').get(id), undefined)
  })
})
