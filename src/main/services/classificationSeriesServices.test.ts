import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { classificationMaintenanceService } from './classificationMaintenanceService'
import { classificationQueryService } from './classificationQueryService'
import { videoQueryService } from './videoQueryService'

function withDatabase(run: () => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-series-'))
  try {
    initDatabaseAtPath(path.join(tempDir, 'library.db'))
    run()
  } finally {
    closeDatabase()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function createOrganization(name: string): number {
  return classificationMaintenanceService.createOrganization({ role: 'maker', mainName: name })
}

function insertVideo(code: string, releaseDate?: string, coverPath?: string): number {
  return Number(
    getDb()
      .prepare('INSERT INTO videos (code, release_date, cover_path) VALUES (?, ?, ?)')
      .run(code, releaseDate ?? null, coverPath ?? null).lastInsertRowid
  )
}

describe('classification series query and maintenance services', () => {
  it('maintains a stable complete profile and projects its local video coverage', () => {
    withDatabase(() => {
      const ownerId = createOrganization('Owner Studio')
      const parentId = classificationMaintenanceService.createSeries({ mainName: 'Parent Series' })
      const seriesId = classificationMaintenanceService.createSeries({ mainName: 'Before' })
      const videoId = insertVideo('SERIES-1', '2022-03-04', 'covers/series.jpg')
      classificationMaintenanceService.assignVideoSeries(videoId, { seriesId })

      classificationMaintenanceService.updateSeries(seriesId, {
        mainName: 'After',
        keepPreviousMainName: true,
        aliases: ['Alias'],
        summary: 'Line 1\nLine 2',
        ownerOrganizationId: ownerId,
        parentSeriesId: parentId,
        startYear: 2001,
        endYear: 2024,
        status: 'completed',
        links: [{ label: '', url: 'https://example.com/series' }]
      })

      const detail = classificationQueryService.getSeries(seriesId)
      assert.equal(detail?.id, seriesId)
      assert.equal(detail?.mainName, 'After')
      assert.deepEqual(detail?.aliases, ['Before', 'Alias'])
      assert.equal(detail?.summary, 'Line 1\nLine 2')
      assert.equal(detail?.ownerOrganization?.id, ownerId)
      assert.equal(detail?.parentSeries?.id, parentId)
      assert.equal(detail?.startYear, 2001)
      assert.equal(detail?.endYear, 2024)
      assert.equal(detail?.status, 'completed')
      assert.equal(detail?.links[0]?.label, 'example.com')
      assert.equal(detail?.videoCount, 1)
      assert.equal(detail?.releaseYearStart, 2022)
      assert.equal(detail?.releaseYearEnd, 2022)
      assert.equal(detail?.fallbackCoverPath, 'covers/series.jpg')
      assert.deepEqual(
        getDb().prepare('SELECT series_id, series FROM videos WHERE id = ?').get(videoId),
        { series_id: seriesId, series: 'After' }
      )
    })
  })

  it('enforces normalized name ownership inside the owner scope only', () => {
    withDatabase(() => {
      const firstOwner = createOrganization('First Owner')
      const secondOwner = createOrganization('Second Owner')
      const first = classificationMaintenanceService.createSeries({
        mainName: 'Shared Name',
        aliases: ['Shared Alias'],
        ownerOrganizationId: firstOwner
      })
      const second = classificationMaintenanceService.createSeries({
        mainName: 'Ｓｈａｒｅｄ　Ｎａｍｅ',
        aliases: ['ＳＨＡＲＥＤ ＡＬＩＡＳ'],
        ownerOrganizationId: secondOwner
      })
      classificationMaintenanceService.createSeries({ mainName: 'Shared Name' })

      assert.ok(first)
      assert.ok(second)
      assert.throws(
        () =>
          classificationMaintenanceService.createSeries({
            mainName: 'Another',
            aliases: [' shared alias '],
            ownerOrganizationId: firstOwner
          }),
        /名称.*作用域/
      )
      assert.throws(
        () => classificationMaintenanceService.createSeries({ mainName: ' shared name ' }),
        /名称.*作用域/
      )
    })
  })

  it('preflights every name when moving to another owner scope and rolls back on conflict', () => {
    withDatabase(() => {
      const firstOwner = createOrganization('First Owner')
      const secondOwner = createOrganization('Second Owner')
      const moving = classificationMaintenanceService.createSeries({
        mainName: 'Moving',
        aliases: ['Collision'],
        ownerOrganizationId: firstOwner
      })
      classificationMaintenanceService.createSeries({
        mainName: 'COLLISION',
        ownerOrganizationId: secondOwner
      })

      assert.throws(
        () =>
          classificationMaintenanceService.updateSeries(moving, {
            mainName: 'Changed',
            aliases: ['Collision'],
            ownerOrganizationId: secondOwner,
            summary: 'must rollback'
          }),
        /名称.*作用域/
      )
      const detail = classificationQueryService.getSeries(moving)
      assert.equal(detail?.mainName, 'Moving')
      assert.equal(detail?.ownerOrganization?.id, firstOwner)
      assert.equal(detail?.summary, null)
    })
  })

  it('rejects self and descendant parents without partially changing the series', () => {
    withDatabase(() => {
      const parent = classificationMaintenanceService.createSeries({ mainName: 'Parent' })
      const child = classificationMaintenanceService.createSeries({
        mainName: 'Child',
        parentSeriesId: parent
      })

      assert.throws(
        () =>
          classificationMaintenanceService.updateSeries(parent, {
            mainName: 'Parent',
            parentSeriesId: parent
          }),
        /自身/
      )
      assert.throws(
        () =>
          classificationMaintenanceService.updateSeries(parent, {
            mainName: 'Changed',
            parentSeriesId: child
          }),
        /循环/
      )
      assert.equal(classificationQueryService.getSeries(parent)?.mainName, 'Parent')
      assert.equal(classificationQueryService.getSeries(child)?.parentSeries?.id, parent)
    })
  })

  it('searches aliases, identifies same-name candidates, and sorts in either direction', () => {
    withDatabase(() => {
      const firstOwner = createOrganization('First Owner')
      const secondOwner = createOrganization('Second Owner')
      const older = classificationMaintenanceService.createSeries({
        mainName: 'Series',
        aliases: ['Needle'],
        ownerOrganizationId: firstOwner
      })
      const newer = classificationMaintenanceService.createSeries({
        mainName: 'Series',
        ownerOrganizationId: secondOwner
      })
      const videoId = insertVideo('SERIES-SORT')
      classificationMaintenanceService.assignVideoSeries(videoId, { seriesId: older })
      const earlierVideoId = insertVideo('SERIES-EARLIER', '2020-01-02')
      const laterVideoId = insertVideo('SERIES-LATER', '2024-05-06')
      classificationMaintenanceService.assignVideoSeries(earlierVideoId, { seriesId: older })
      classificationMaintenanceService.assignVideoSeries(laterVideoId, { seriesId: older })
      getDb().prepare('UPDATE series SET updated_at = ? WHERE id = ?').run('2020-01-01', older)
      getDb().prepare('UPDATE series SET updated_at = ? WHERE id = ?').run('2025-01-01', newer)

      assert.deepEqual(
        classificationQueryService.listSeries({ search: 'needle' }).map((item) => item.id),
        [older]
      )
      assert.deepEqual(
        classificationQueryService
          .listSeries({ sortBy: 'updated_at', sortDir: 'desc' })
          .map((item) => item.id),
        [newer, older]
      )
      assert.deepEqual(
        classificationQueryService
          .listSeries({ sortBy: 'video_count', sortDir: 'asc' })
          .map((item) => item.id),
        [newer, older]
      )
      assert.deepEqual(
        classificationQueryService.listSeriesOptions('series').map((item) => ({
          id: item.id,
          owner: item.ownerOrganization?.mainName
        })),
        [
          { id: older, owner: 'First Owner' },
          { id: newer, owner: 'Second Owner' }
        ]
      )
      assert.deepEqual(
        videoQueryService
          .list({ seriesId: older, sortBy: 'release_date', sortDir: 'desc' })
          .items.map((item) => item.code),
        ['SERIES-LATER', 'SERIES-EARLIER', 'SERIES-SORT']
      )
      assert.deepEqual(
        videoQueryService
          .list({ seriesId: older, sortBy: 'release_date', sortDir: 'asc' })
          .items.map((item) => item.code),
        ['SERIES-EARLIER', 'SERIES-LATER', 'SERIES-SORT']
      )
    })
  })

  it('creates an unowned series inline and validates lifecycle years', () => {
    withDatabase(() => {
      const videoId = insertVideo('SERIES-INLINE')
      const assigned = classificationMaintenanceService.assignVideoSeries(videoId, {
        createName: 'Inline Series'
      })
      assert.ok(assigned.seriesId)
      assert.equal(assigned.mainName, 'Inline Series')
      assert.equal(classificationQueryService.getSeries(assigned.seriesId!)?.ownerOrganization, null)
      assert.throws(
        () =>
          classificationMaintenanceService.createSeries({
            mainName: 'Invalid years',
            startYear: 2024,
            endYear: 2000
          }),
        /不能晚于/
      )
    })
  })
})
