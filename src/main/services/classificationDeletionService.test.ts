import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { classificationMaintenanceService } from './classificationMaintenanceService'
import {
  classificationDeletionService,
  createClassificationDeletionService
} from './classificationDeletionService'

let tempRoot: string | null = null

function setup(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-classification-delete-'))
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
}

function createVideo(code: string, title = 'Keep metadata'): number {
  return Number(
    getDb()
      .prepare('INSERT INTO videos (code, title) VALUES (?, ?)')
      .run(code, title).lastInsertRowid
  )
}

function addResource(videoId: number, key: string): void {
  getDb()
    .prepare(
      `INSERT INTO video_resources (video_id, kind, locator, resource_key, display_name)
       VALUES (?, 'web', ?, ?, 'Keep resource')`
    )
    .run(videoId, `https://example.com/${key}`, key)
}

afterEach(() => {
  closeDatabase()
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('classificationDeletionService', () => {
  it('previews and deletes a director while recalculating links and preserving videos/resources', () => {
    setup()
    const directorId = classificationMaintenanceService.createDirector({ mainName: 'Director' })
    const firstVideoId = createVideo('DELETE-DIRECTOR-1')
    classificationMaintenanceService.assignVideoDirector(firstVideoId, { directorId })
    addResource(firstVideoId, 'director-resource')
    getDb().prepare('UPDATE directors SET image_path = ? WHERE id = ?').run(
      'avatars/director-delete.jpg',
      directorId
    )
    assert.deepEqual(classificationDeletionService.previewDirector(directorId), {
      id: directorId,
      videoCount: 1
    })
    const secondVideoId = createVideo('DELETE-DIRECTOR-2')
    classificationMaintenanceService.assignVideoDirector(secondVideoId, { directorId })
    const deletedImages: string[] = []
    const service = createClassificationDeletionService({
      deleteStoredImage: (storedPath) => deletedImages.push(storedPath)
    })

    const result = service.deleteDirector(directorId)

    assert.deepEqual(result, { id: directorId, unlinkedVideoCount: 2, cleanupFailures: [] })
    assert.deepEqual(
      getDb().prepare('SELECT title, director_id, director FROM videos WHERE id = ?').get(firstVideoId),
      { title: 'Keep metadata', director_id: null, director: null }
    )
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS count FROM video_resources WHERE video_id = ?').get(
        firstVideoId
      ) as { count: number }).count,
      1
    )
    assert.equal(getDb().prepare('SELECT 1 FROM directors WHERE id = ?').get(directorId), undefined)
    assert.deepEqual(deletedImages, ['avatars/director-delete.jpg'])
  })

  it('deletes an unlinked director with a zero impact', () => {
    setup()
    const id = classificationMaintenanceService.createDirector({ mainName: 'Empty Director' })
    assert.deepEqual(classificationDeletionService.previewDirector(id), { id, videoCount: 0 })
    assert.deepEqual(classificationDeletionService.deleteDirector(id), {
      id,
      unlinkedVideoCount: 0,
      cleanupFailures: []
    })
  })

  it('rolls back director unlinking and skips image cleanup when deletion fails', () => {
    setup()
    const id = classificationMaintenanceService.createDirector({ mainName: 'Rollback Director' })
    const videoId = createVideo('DELETE-DIRECTOR-ROLLBACK')
    classificationMaintenanceService.assignVideoDirector(videoId, { directorId: id })
    getDb().prepare('UPDATE directors SET image_path = ? WHERE id = ?').run('locked.jpg', id)
    getDb().exec(`CREATE TRIGGER fail_director_delete BEFORE DELETE ON directors
      WHEN OLD.id = ${id} BEGIN SELECT RAISE(ABORT, 'forced director delete failure'); END`)
    const deletedImages: string[] = []
    const service = createClassificationDeletionService({
      deleteStoredImage: (storedPath) => deletedImages.push(storedPath)
    })

    assert.throws(() => service.deleteDirector(id), /forced director delete failure/)
    assert.deepEqual(
      getDb().prepare('SELECT director_id, director FROM videos WHERE id = ?').get(videoId),
      { director_id: id, director: 'Rollback Director' }
    )
    assert.ok(getDb().prepare('SELECT 1 FROM directors WHERE id = ?').get(id))
    assert.deepEqual(deletedImages, [])
  })

  it('previews and deletes a series while recalculating videos and detaching direct children', () => {
    setup()
    const id = classificationMaintenanceService.createSeries({ mainName: 'Series' })
    const childId = classificationMaintenanceService.createSeries({
      mainName: 'Child',
      parentSeriesId: id
    })
    const firstVideoId = createVideo('DELETE-SERIES-1')
    classificationMaintenanceService.assignVideoSeries(firstVideoId, { seriesId: id })
    addResource(firstVideoId, 'series-resource')
    assert.deepEqual(classificationDeletionService.previewSeries(id), {
      id,
      videoCount: 1,
      directChildCount: 1
    })
    const secondVideoId = createVideo('DELETE-SERIES-2')
    classificationMaintenanceService.assignVideoSeries(secondVideoId, { seriesId: id })

    const result = classificationDeletionService.deleteSeries(id)

    assert.deepEqual(result, {
      id,
      unlinkedVideoCount: 2,
      detachedChildCount: 1,
      cleanupFailures: []
    })
    assert.deepEqual(
      getDb().prepare('SELECT title, series_id, series FROM videos WHERE id = ?').get(firstVideoId),
      { title: 'Keep metadata', series_id: null, series: null }
    )
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS count FROM video_resources WHERE video_id = ?').get(
        firstVideoId
      ) as { count: number }).count,
      1
    )
    assert.deepEqual(getDb().prepare('SELECT parent_series_id FROM series WHERE id = ?').get(childId), {
      parent_series_id: null
    })
  })

  it('deletes an unlinked childless series with a zero impact', () => {
    setup()
    const id = classificationMaintenanceService.createSeries({ mainName: 'Empty Series' })
    assert.deepEqual(classificationDeletionService.previewSeries(id), {
      id,
      videoCount: 0,
      directChildCount: 0
    })
    assert.deepEqual(classificationDeletionService.deleteSeries(id), {
      id,
      unlinkedVideoCount: 0,
      detachedChildCount: 0,
      cleanupFailures: []
    })
  })

  it('rolls back series relations and reports image cleanup failure only after commit', () => {
    setup()
    const rollbackId = classificationMaintenanceService.createSeries({ mainName: 'Rollback Series' })
    const childId = classificationMaintenanceService.createSeries({
      mainName: 'Rollback Child',
      parentSeriesId: rollbackId
    })
    const videoId = createVideo('DELETE-SERIES-ROLLBACK')
    classificationMaintenanceService.assignVideoSeries(videoId, { seriesId: rollbackId })
    getDb().exec(`CREATE TRIGGER fail_series_delete BEFORE DELETE ON series
      WHEN OLD.id = ${rollbackId} BEGIN SELECT RAISE(ABORT, 'forced series delete failure'); END`)
    assert.throws(() => classificationDeletionService.deleteSeries(rollbackId), /forced series/)
    assert.deepEqual(getDb().prepare('SELECT series_id FROM videos WHERE id = ?').get(videoId), {
      series_id: rollbackId
    })
    assert.deepEqual(getDb().prepare('SELECT parent_series_id FROM series WHERE id = ?').get(childId), {
      parent_series_id: rollbackId
    })

    const cleanupId = classificationMaintenanceService.createSeries({ mainName: 'Cleanup Series' })
    getDb().prepare('UPDATE series SET image_path = ? WHERE id = ?').run('covers/cleanup.jpg', cleanupId)
    const service = createClassificationDeletionService({
      deleteStoredImage: () => {
        throw new Error('image locked')
      }
    })
    assert.deepEqual(service.deleteSeries(cleanupId), {
      id: cleanupId,
      unlinkedVideoCount: 0,
      detachedChildCount: 0,
      cleanupFailures: [{ path: 'covers/cleanup.jpg', error: 'image locked' }]
    })
    assert.equal(getDb().prepare('SELECT 1 FROM series WHERE id = ?').get(cleanupId), undefined)
  })
})
