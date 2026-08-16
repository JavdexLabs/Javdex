import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { getVideoById } from '../db/videoRepo'
import { classificationMaintenanceService } from './classificationMaintenanceService'
import { classificationQueryService } from './classificationQueryService'
import { createSeriesMergeService, seriesMergeService } from './seriesMergeService'

let tempRoot: string | null = null

function setup(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-series-merge-'))
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
}

function createVideo(code: string, seriesId: number): number {
  return Number(
    getDb()
      .prepare('INSERT INTO videos (code, series_id) VALUES (?, ?)')
      .run(code, seriesId)
      .lastInsertRowid
  )
}

function setImagePath(id: number, imagePath: string): void {
  getDb().prepare('UPDATE series SET image_path = ? WHERE id = ?').run(imagePath, id)
}

afterEach(() => {
  closeDatabase()
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('seriesMergeService', () => {
  it('merges an explicit source into the target and transfers videos and direct children', () => {
    setup()
    const ownerId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Owner Studio'
    })
    const parentId = classificationMaintenanceService.createSeries({
      mainName: 'Parent Collection',
      ownerOrganizationId: ownerId
    })
    const targetId = classificationMaintenanceService.createSeries({
      mainName: 'Target Series',
      aliases: ['Target Alias', 'Shared Alias'],
      summary: 'Keep target summary',
      startYear: 2001,
      links: [
        { label: 'Target', url: 'https://example.com/target' },
        { label: 'Shared target', url: 'https://example.com/shared#target' }
      ]
    })
    const sourceId = classificationMaintenanceService.createSeries({
      mainName: 'Source Series',
      aliases: ['Shared  Alias', 'Source Alias'],
      summary: 'Do not replace target summary',
      ownerOrganizationId: ownerId,
      parentSeriesId: parentId,
      startYear: 2010,
      endYear: 2024,
      status: 'completed',
      links: [
        { label: 'Shared source', url: 'https://example.com/shared#source' },
        { label: 'Source', url: 'https://example.com/source' }
      ]
    })
    const childId = classificationMaintenanceService.createSeries({
      mainName: 'Source Child',
      ownerOrganizationId: ownerId,
      parentSeriesId: sourceId
    })
    setImagePath(targetId, 'covers/series-target.jpg')
    setImagePath(sourceId, 'covers/series-source.jpg')
    createVideo('SERIES-TARGET', targetId)
    const sourceVideoId = createVideo('SERIES-SOURCE', sourceId)
    const deletedImages: string[] = []
    const service = createSeriesMergeService({
      deleteStoredImage: (storedPath) => {
        assert.equal(classificationQueryService.getSeries(sourceId), null)
        assert.equal(classificationQueryService.getSeries(childId)?.parentSeries?.id, targetId)
        deletedImages.push(storedPath)
      }
    })

    const result = service.merge({ targetId, sourceId })

    const target = classificationQueryService.getSeries(targetId)
    assert.equal(classificationQueryService.getSeries(sourceId), null)
    assert.equal(target?.mainName, 'Target Series')
    assert.deepEqual(target?.aliases, [
      'Target Alias',
      'Shared Alias',
      'Source Series',
      'Source Alias'
    ])
    assert.equal(target?.summary, 'Keep target summary')
    assert.equal(target?.ownerOrganization?.id, ownerId)
    assert.equal(target?.parentSeries?.id, parentId)
    assert.equal(target?.startYear, 2001)
    assert.equal(target?.endYear, 2024)
    assert.equal(target?.status, 'completed')
    assert.equal(target?.imagePath, 'covers/series-target.jpg')
    assert.deepEqual(
      target?.links.map((link) => [link.label, link.url]),
      [
        ['Target', 'https://example.com/target'],
        ['Shared target', 'https://example.com/shared#target'],
        ['Source', 'https://example.com/source']
      ]
    )
    assert.deepEqual(
      { seriesId: getVideoById(sourceVideoId)?.series_id, series: getVideoById(sourceVideoId)?.series },
      { seriesId: targetId, series: 'Target Series' }
    )
    assert.equal(classificationQueryService.getSeries(childId)?.parentSeries?.id, targetId)
    assert.equal(result.transferredVideoCount, 1)
    assert.equal(result.transferredChildCount, 1)
    assert.equal(result.imagePath, 'covers/series-target.jpg')
    assert.deepEqual(result.cleanupFailures, [])
    assert.deepEqual(deletedImages, ['covers/series-source.jpg'])
  })

  it('adopts the source cover only when the target has no formal cover', () => {
    setup()
    const targetId = classificationMaintenanceService.createSeries({ mainName: 'Target' })
    const sourceId = classificationMaintenanceService.createSeries({ mainName: 'Source' })
    setImagePath(sourceId, 'covers/series-source.jpg')
    const deletedImages: string[] = []
    const service = createSeriesMergeService({
      deleteStoredImage: (storedPath) => deletedImages.push(storedPath)
    })

    const result = service.merge({ targetId, sourceId })

    assert.equal(classificationQueryService.getSeries(targetId)?.imagePath, 'covers/series-source.jpg')
    assert.equal(result.imagePath, 'covers/series-source.jpg')
    assert.deepEqual(result.cleanupFailures, [])
    assert.deepEqual(deletedImages, [])
  })

  it('rejects a merged name collision in the final owner scope without changing relations', () => {
    setup()
    const ownerId = classificationMaintenanceService.createOrganization({
      role: 'maker',
      mainName: 'Owner Studio'
    })
    const targetId = classificationMaintenanceService.createSeries({ mainName: 'Collision' })
    const sourceId = classificationMaintenanceService.createSeries({
      mainName: 'Source',
      ownerOrganizationId: ownerId
    })
    classificationMaintenanceService.createSeries({
      mainName: 'ＣＯＬＬＩＳＩＯＮ',
      ownerOrganizationId: ownerId
    })
    const childId = classificationMaintenanceService.createSeries({
      mainName: 'Child',
      ownerOrganizationId: ownerId,
      parentSeriesId: sourceId
    })
    const sourceVideoId = createVideo('SERIES-CONFLICT', sourceId)
    setImagePath(sourceId, 'covers/series-source.jpg')
    const deletedImages: string[] = []
    const service = createSeriesMergeService({
      deleteStoredImage: (storedPath) => deletedImages.push(storedPath)
    })

    assert.throws(
      () => service.merge({ targetId, sourceId }),
      /系列名称“ＣＯＬＬＩＳＩＯＮ”.*档案 #\d+.*所属机构：Owner Studio.*先修改或合并/
    )

    assert.equal(classificationQueryService.getSeries(targetId)?.ownerOrganization, null)
    assert.equal(classificationQueryService.getSeries(sourceId)?.mainName, 'Source')
    assert.equal(classificationQueryService.getSeries(childId)?.parentSeries?.id, sourceId)
    assert.deepEqual(
      { seriesId: getVideoById(sourceVideoId)?.series_id, series: getVideoById(sourceVideoId)?.series },
      { seriesId: sourceId, series: 'Source' }
    )
    assert.deepEqual(deletedImages, [])
  })

  it('rejects a merge that would move an ancestor branch below its descendant', () => {
    setup()
    const sourceId = classificationMaintenanceService.createSeries({ mainName: 'Source Root' })
    const branchId = classificationMaintenanceService.createSeries({
      mainName: 'Branch',
      parentSeriesId: sourceId
    })
    const targetId = classificationMaintenanceService.createSeries({
      mainName: 'Target Descendant',
      parentSeriesId: branchId
    })

    assert.throws(() => seriesMergeService.merge({ targetId, sourceId }), /层级|循环/)

    assert.equal(classificationQueryService.getSeries(sourceId)?.parentSeries, null)
    assert.equal(classificationQueryService.getSeries(branchId)?.parentSeries?.id, sourceId)
    assert.equal(classificationQueryService.getSeries(targetId)?.parentSeries?.id, branchId)
  })

  it('collapses a direct source-to-target hierarchy without making the target its own parent', () => {
    setup()
    const rootId = classificationMaintenanceService.createSeries({ mainName: 'Root' })
    const sourceId = classificationMaintenanceService.createSeries({
      mainName: 'Source Parent',
      parentSeriesId: rootId
    })
    const targetId = classificationMaintenanceService.createSeries({
      mainName: 'Target Child',
      parentSeriesId: sourceId
    })
    const siblingId = classificationMaintenanceService.createSeries({
      mainName: 'Source Sibling',
      parentSeriesId: sourceId
    })

    const result = seriesMergeService.merge({ targetId, sourceId })

    assert.equal(classificationQueryService.getSeries(sourceId), null)
    assert.equal(classificationQueryService.getSeries(targetId)?.parentSeries?.id, rootId)
    assert.equal(classificationQueryService.getSeries(siblingId)?.parentSeries?.id, targetId)
    assert.equal(result.transferredChildCount, 1)
  })

  it('rolls back profile, video, and child changes when the database transaction fails', () => {
    setup()
    const targetId = classificationMaintenanceService.createSeries({
      mainName: 'Target',
      summary: 'Target summary'
    })
    const sourceId = classificationMaintenanceService.createSeries({
      mainName: 'Source',
      endYear: 2024
    })
    const childId = classificationMaintenanceService.createSeries({
      mainName: 'Child',
      parentSeriesId: sourceId
    })
    const sourceVideoId = createVideo('SERIES-ROLLBACK', sourceId)
    setImagePath(sourceId, 'covers/series-source.jpg')
    getDb().exec(`CREATE TRIGGER fail_series_merge BEFORE DELETE ON series
      WHEN OLD.id = ${sourceId}
      BEGIN SELECT RAISE(ABORT, 'forced series merge failure'); END`)
    const deletedImages: string[] = []
    const service = createSeriesMergeService({
      deleteStoredImage: (storedPath) => deletedImages.push(storedPath)
    })

    assert.throws(() => service.merge({ targetId, sourceId }), /forced series merge failure/)

    assert.equal(classificationQueryService.getSeries(targetId)?.endYear, null)
    assert.equal(classificationQueryService.getSeries(sourceId)?.mainName, 'Source')
    assert.equal(classificationQueryService.getSeries(childId)?.parentSeries?.id, sourceId)
    assert.deepEqual(
      { seriesId: getVideoById(sourceVideoId)?.series_id, series: getVideoById(sourceVideoId)?.series },
      { seriesId: sourceId, series: 'Source' }
    )
    assert.deepEqual(deletedImages, [])
  })

  it('commits the merge and reports an obsolete source cover cleanup failure', () => {
    setup()
    const targetId = classificationMaintenanceService.createSeries({ mainName: 'Target' })
    const sourceId = classificationMaintenanceService.createSeries({ mainName: 'Source' })
    setImagePath(targetId, 'covers/series-target.jpg')
    setImagePath(sourceId, 'covers/series-source.jpg')
    const service = createSeriesMergeService({
      deleteStoredImage: () => {
        throw new Error('cover locked')
      }
    })

    const result = service.merge({ targetId, sourceId })

    assert.equal(classificationQueryService.getSeries(sourceId), null)
    assert.equal(classificationQueryService.getSeries(targetId)?.imagePath, 'covers/series-target.jpg')
    assert.deepEqual(result.cleanupFailures, [
      { path: 'covers/series-source.jpg', error: 'cover locked' }
    ])
  })

  it('rejects using the same series as target and source', () => {
    setup()
    const seriesId = classificationMaintenanceService.createSeries({ mainName: 'Same' })

    assert.throws(
      () => seriesMergeService.merge({ targetId: seriesId, sourceId: seriesId }),
      /不能合并同一系列/
    )
    assert.equal(classificationQueryService.getSeries(seriesId)?.mainName, 'Same')
  })
})
