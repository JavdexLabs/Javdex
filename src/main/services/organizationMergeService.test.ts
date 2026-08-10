import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { classificationMaintenanceService } from './classificationMaintenanceService'
import { classificationQueryService } from './classificationQueryService'
import {
  createOrganizationMergeService,
  organizationMergeService
} from './organizationMergeService'

let tempRoot: string | null = null

function setup(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-organization-merge-'))
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
}

function createVideo(code: string): number {
  return Number(
    getDb().prepare('INSERT INTO videos (code) VALUES (?)').run(code).lastInsertRowid
  )
}

function setImagePath(id: number, imagePath: string): void {
  getDb().prepare('UPDATE organizations SET image_path = ? WHERE id = ?').run(imagePath, id)
}

afterEach(() => {
  closeDatabase()
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('organizationMergeService', () => {
  it('merges cross-role records and transfers role-specific videos, children, and series', () => {
    setup()
    const rootId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Root Group'
    })
    const targetId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Target Studio',
      aliases: ['Target Alias', 'Shared Alias'],
      summary: 'Keep target summary',
      foundedYear: 2001,
      links: [
        { label: 'Target', url: 'https://example.com/target' },
        { label: 'Shared target', url: 'https://example.com/shared#target' }
      ]
    })
    const sourceId = classificationMaintenanceService.createOrganization({
      role: 'publisher',
      mainName: 'Source Publisher',
      aliases: ['Source Alias'],
      summary: 'Do not replace target summary',
      countryRegion: 'JP',
      endedYear: 2024,
      status: 'active',
      parentOrganizationId: rootId,
      links: [
        { label: 'Shared source', url: 'https://example.com/shared#source' },
        { label: 'Source', url: 'https://example.com/source' }
      ]
    })
    const childId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Source Child',
      parentOrganizationId: sourceId
    })
    const seriesId = classificationMaintenanceService.createSeries({
      mainName: 'Source Collection',
      ownerOrganizationId: sourceId
    })
    const makerVideoId = createVideo('ORG-MAKER')
    const publisherVideoId = createVideo('ORG-PUBLISHER')
    const bothVideoId = createVideo('ORG-BOTH')
    classificationMaintenanceService.assignVideoOrganization(makerVideoId, 'maker', {
      organizationId: sourceId
    })
    classificationMaintenanceService.assignVideoOrganization(publisherVideoId, 'publisher', {
      organizationId: sourceId
    })
    classificationMaintenanceService.assignVideoOrganization(bothVideoId, 'maker', {
      organizationId: sourceId
    })
    classificationMaintenanceService.assignVideoOrganization(bothVideoId, 'publisher', {
      organizationId: sourceId
    })
    assert.deepEqual(
      classificationQueryService.listOrganizationMergeOptions('Source Publisher')[0],
      {
        id: sourceId,
        mainName: 'Source Publisher',
        aliases: ['Source Alias'],
        roles: ['maker', 'publisher'],
        videoCount: 3,
        makerVideoCount: 2,
        publisherVideoCount: 2
      }
    )
    setImagePath(targetId, 'covers/organization-target.jpg')
    setImagePath(sourceId, 'covers/organization-source.jpg')
    const deletedImages: string[] = []
    const service = createOrganizationMergeService({
      deleteStoredImage: (storedPath) => {
        assert.equal(classificationQueryService.getOrganization(sourceId, 'publisher'), null)
        deletedImages.push(storedPath)
      }
    })

    const result = service.merge({ targetId, sourceId })

    const target = classificationQueryService.getOrganization(targetId, 'maker')
    assert.equal(classificationQueryService.getOrganization(sourceId, 'publisher'), null)
    assert.equal(target?.mainName, 'Target Studio')
    assert.deepEqual(target?.aliases, [
      'Target Alias',
      'Shared Alias',
      'Source Publisher',
      'Source Alias'
    ])
    assert.equal(target?.summary, 'Keep target summary')
    assert.equal(target?.countryRegion, 'JP')
    assert.equal(target?.foundedYear, 2001)
    assert.equal(target?.endedYear, 2024)
    assert.equal(target?.status, 'active')
    assert.equal(target?.parent?.id, rootId)
    assert.deepEqual(target?.roles, ['maker', 'publisher'])
    assert.equal(target?.imagePath, 'covers/organization-target.jpg')
    assert.deepEqual(
      target?.links.map((link) => [link.label, link.url]),
      [
        ['Target', 'https://example.com/target'],
        ['Shared target', 'https://example.com/shared#target'],
        ['Source', 'https://example.com/source']
      ]
    )
    assert.deepEqual(
      getDb()
        .prepare(
          `SELECT maker_organization_id, maker, publisher_organization_id, publisher
           FROM videos WHERE id = ?`
        )
        .get(bothVideoId),
      {
        maker_organization_id: targetId,
        maker: 'Target Studio',
        publisher_organization_id: targetId,
        publisher: 'Target Studio'
      }
    )
    assert.equal(classificationQueryService.getOrganization(childId, 'maker')?.parent?.id, targetId)
    assert.equal(classificationQueryService.getSeries(seriesId)?.ownerOrganization?.id, targetId)
    assert.deepEqual(
      getDb()
        .prepare(
          'SELECT DISTINCT owner_organization_id FROM series_name_ownership WHERE series_id = ?'
        )
        .all(seriesId),
      [{ owner_organization_id: targetId }]
    )
    assert.equal(target?.makerVideoCount, 2)
    assert.equal(target?.publisherVideoCount, 2)
    assert.deepEqual(result, {
      targetId,
      sourceId,
      transferredMakerVideoCount: 2,
      transferredPublisherVideoCount: 2,
      transferredChildCount: 1,
      transferredSeriesCount: 1,
      imagePath: 'covers/organization-target.jpg',
      cleanupFailures: []
    })
    assert.deepEqual(deletedImages, ['covers/organization-source.jpg'])
  })

  it('adopts the source brand image only when the target has none', () => {
    setup()
    const targetId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Target'
    })
    const sourceId = classificationMaintenanceService.createOrganization({
      role: 'publisher',
      mainName: 'Source'
    })
    setImagePath(sourceId, 'covers/organization-source.jpg')
    const deletedImages: string[] = []
    const service = createOrganizationMergeService({
      deleteStoredImage: (storedPath) => deletedImages.push(storedPath)
    })

    const result = service.merge({ targetId, sourceId })

    assert.equal(
      classificationQueryService.getOrganization(targetId, 'maker')?.imagePath,
      'covers/organization-source.jpg'
    )
    assert.equal(result.imagePath, 'covers/organization-source.jpg')
    assert.deepEqual(deletedImages, [])
  })

  it('rejects a series name collision in the target scope without changing any relation', () => {
    setup()
    const targetId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Target'
    })
    const sourceId = classificationMaintenanceService.createOrganization({
      role: 'publisher',
      mainName: 'Source'
    })
    const targetSeriesId = classificationMaintenanceService.createSeries({
      mainName: 'Collision',
      ownerOrganizationId: targetId
    })
    const sourceSeriesId = classificationMaintenanceService.createSeries({
      mainName: 'Source Series',
      aliases: ['ＣＯＬＬＩＳＩＯＮ'],
      ownerOrganizationId: sourceId
    })
    const childId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Source Child',
      parentOrganizationId: sourceId
    })
    const videoId = createVideo('ORG-CONFLICT')
    classificationMaintenanceService.assignVideoOrganization(videoId, 'publisher', {
      organizationId: sourceId
    })
    setImagePath(sourceId, 'covers/organization-source.jpg')
    const deletedImages: string[] = []
    const service = createOrganizationMergeService({
      deleteStoredImage: (storedPath) => deletedImages.push(storedPath)
    })

    assert.throws(
      () => service.merge({ targetId, sourceId }),
      new RegExp(
        `来源系列 #${sourceSeriesId}.*ＣＯＬＬＩＳＩＯＮ.*目标机构内系列 #${targetSeriesId}.*先修改或合并`
      )
    )

    assert.equal(classificationQueryService.getOrganization(sourceId, 'publisher')?.mainName, 'Source')
    assert.equal(classificationQueryService.getOrganization(childId, 'maker')?.parent?.id, sourceId)
    assert.equal(classificationQueryService.getSeries(sourceSeriesId)?.ownerOrganization?.id, sourceId)
    assert.deepEqual(
      getDb().prepare('SELECT publisher_organization_id FROM videos WHERE id = ?').get(videoId),
      { publisher_organization_id: sourceId }
    )
    assert.deepEqual(deletedImages, [])
  })

  it('rejects merging an ancestor into a deep descendant', () => {
    setup()
    const sourceId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Source Root'
    })
    const branchId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Branch',
      parentOrganizationId: sourceId
    })
    const targetId = classificationMaintenanceService.createOrganization({
      role: 'publisher',
      mainName: 'Target Descendant',
      parentOrganizationId: branchId
    })

    assert.throws(() => organizationMergeService.merge({ targetId, sourceId }), /层级|循环/)

    assert.equal(classificationQueryService.getOrganization(branchId, 'maker')?.parent?.id, sourceId)
    assert.equal(
      classificationQueryService.getOrganization(targetId, 'publisher')?.parent?.id,
      branchId
    )
  })

  it('collapses a direct source-to-target hierarchy and transfers source siblings', () => {
    setup()
    const rootId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Root'
    })
    const sourceId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Source Parent',
      parentOrganizationId: rootId
    })
    const targetId = classificationMaintenanceService.createOrganization({
      role: 'publisher',
      mainName: 'Target Child',
      parentOrganizationId: sourceId
    })
    const siblingId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Source Sibling',
      parentOrganizationId: sourceId
    })

    const result = organizationMergeService.merge({ targetId, sourceId })

    assert.equal(classificationQueryService.getOrganization(targetId, 'publisher')?.parent?.id, rootId)
    assert.equal(classificationQueryService.getOrganization(siblingId, 'maker')?.parent?.id, targetId)
    assert.equal(result.transferredChildCount, 1)
  })

  it('rolls back the profile and every relation when the transaction fails', () => {
    setup()
    const targetId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Target',
      summary: 'Target summary'
    })
    const sourceId = classificationMaintenanceService.createOrganization({
      role: 'publisher',
      mainName: 'Source',
      countryRegion: 'JP'
    })
    const childId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Child',
      parentOrganizationId: sourceId
    })
    const seriesId = classificationMaintenanceService.createSeries({
      mainName: 'Source Series',
      ownerOrganizationId: sourceId
    })
    const videoId = createVideo('ORG-ROLLBACK')
    classificationMaintenanceService.assignVideoOrganization(videoId, 'publisher', {
      organizationId: sourceId
    })
    setImagePath(sourceId, 'covers/organization-source.jpg')
    getDb().exec(`CREATE TRIGGER fail_organization_merge BEFORE DELETE ON organizations
      WHEN OLD.id = ${sourceId}
      BEGIN SELECT RAISE(ABORT, 'forced organization merge failure'); END`)
    const deletedImages: string[] = []
    const service = createOrganizationMergeService({
      deleteStoredImage: (storedPath) => deletedImages.push(storedPath)
    })

    assert.throws(() => service.merge({ targetId, sourceId }), /forced organization merge failure/)

    assert.equal(classificationQueryService.getOrganization(targetId, 'maker')?.countryRegion, null)
    assert.equal(classificationQueryService.getOrganization(sourceId, 'publisher')?.mainName, 'Source')
    assert.equal(classificationQueryService.getOrganization(childId, 'maker')?.parent?.id, sourceId)
    assert.equal(classificationQueryService.getSeries(seriesId)?.ownerOrganization?.id, sourceId)
    assert.deepEqual(
      getDb().prepare('SELECT publisher_organization_id FROM videos WHERE id = ?').get(videoId),
      { publisher_organization_id: sourceId }
    )
    assert.deepEqual(deletedImages, [])
  })

  it('commits the merge and reports a brand image cleanup failure', () => {
    setup()
    const targetId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Target'
    })
    const sourceId = classificationMaintenanceService.createOrganization({
      role: 'publisher',
      mainName: 'Source'
    })
    setImagePath(targetId, 'covers/organization-target.jpg')
    setImagePath(sourceId, 'covers/organization-source.jpg')
    const service = createOrganizationMergeService({
      deleteStoredImage: () => {
        throw new Error('brand image locked')
      }
    })

    const result = service.merge({ targetId, sourceId })

    assert.equal(classificationQueryService.getOrganization(sourceId, 'publisher'), null)
    assert.deepEqual(result.cleanupFailures, [
      { path: 'covers/organization-source.jpg', error: 'brand image locked' }
    ])
  })

  it('rejects using the same organization as target and source', () => {
    setup()
    const organizationId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Same'
    })

    assert.throws(
      () => organizationMergeService.merge({ targetId: organizationId, sourceId: organizationId }),
      /不能合并同一机构/
    )
  })
})
