import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { getVideoById } from '@library/db/videoRepo'
import { classificationMaintenanceService } from './classificationMaintenanceService'
import { classificationQueryService } from './classificationQueryService'
import { createDirectorMergeService, directorMergeService } from './directorMergeService'

let tempRoot: string | null = null

function setup(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-director-merge-'))
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
}

function createVideo(code: string, directorId: number): number {
  return Number(
    getDb()
      .prepare('INSERT INTO videos (code, director_id) VALUES (?, ?)')
      .run(code, directorId)
      .lastInsertRowid
  )
}

function setImagePath(id: number, imagePath: string): void {
  getDb().prepare('UPDATE directors SET image_path = ? WHERE id = ?').run(imagePath, id)
}

afterEach(() => {
  closeDatabase()
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('directorMergeService', () => {
  it('merges source data into an explicit target while preserving target conflicts', () => {
    setup()
    const targetId = classificationMaintenanceService.createDirector({
      mainName: 'Target Director',
      aliases: ['Target Alias', 'Shared Alias'],
      summary: 'Keep target summary',
      birthDate: '1970-01-01',
      careerStartYear: 1990,
      links: [
        { label: 'Target', url: 'https://example.com/target' },
        { label: 'Shared target', url: 'https://example.com/shared#target' }
      ]
    })
    const sourceId = classificationMaintenanceService.createDirector({
      mainName: 'Source Director',
      aliases: ['Shared  Alias', 'Source Alias'],
      summary: 'Do not replace target summary',
      countryRegion: 'JP',
      birthDate: '1980-01-01',
      deathDate: '2024-01-01',
      birthPlace: 'Tokyo',
      careerStartYear: 2000,
      careerEndYear: 2022,
      status: 'retired',
      links: [
        { label: 'Shared source', url: 'https://example.com/shared#source' },
        { label: 'Source', url: 'https://example.com/source' }
      ]
    })
    setImagePath(targetId, 'avatars/target.jpg')
    setImagePath(sourceId, 'avatars/source.jpg')
    createVideo('DIR-TARGET', targetId)
    const sourceVideoId = createVideo('DIR-SOURCE', sourceId)
    const deletedImages: string[] = []
    const service = createDirectorMergeService({
      deleteStoredImage: (storedPath) => {
        assert.equal(classificationQueryService.getDirector(sourceId), null)
        deletedImages.push(storedPath)
      }
    })

    const result = service.merge({ targetId, sourceId })

    const target = classificationQueryService.getDirector(targetId)
    assert.equal(classificationQueryService.getDirector(sourceId), null)
    assert.equal(target?.mainName, 'Target Director')
    assert.deepEqual(target?.aliases, [
      'Target Alias',
      'Shared Alias',
      'Source Director',
      'Source Alias'
    ])
    assert.equal(target?.summary, 'Keep target summary')
    assert.equal(target?.countryRegion, 'JP')
    assert.equal(target?.birthDate, '1970-01-01')
    assert.equal(target?.deathDate, '2024-01-01')
    assert.equal(target?.birthPlace, 'Tokyo')
    assert.equal(target?.careerStartYear, 1990)
    assert.equal(target?.careerEndYear, 2022)
    assert.equal(target?.status, 'retired')
    assert.equal(target?.imagePath, 'avatars/target.jpg')
    assert.deepEqual(
      target?.links.map((link) => [link.label, link.url]),
      [
        ['Target', 'https://example.com/target'],
        ['Shared target', 'https://example.com/shared#target'],
        ['Source', 'https://example.com/source']
      ]
    )
    assert.deepEqual(
      { directorId: getVideoById(sourceVideoId)?.director_id, director: getVideoById(sourceVideoId)?.director },
      { directorId: targetId, director: 'Target Director' }
    )
    assert.equal(result.transferredVideoCount, 1)
    assert.equal(result.imagePath, 'avatars/target.jpg')
    assert.deepEqual(result.cleanupFailures, [])
    assert.deepEqual(deletedImages, ['avatars/source.jpg'])
  })

  it('adopts the source portrait only when the target has no formal portrait', () => {
    setup()
    const targetId = classificationMaintenanceService.createDirector({ mainName: 'Target' })
    const sourceId = classificationMaintenanceService.createDirector({ mainName: 'Source' })
    setImagePath(sourceId, 'avatars/source.jpg')
    const deletedImages: string[] = []
    const service = createDirectorMergeService({
      deleteStoredImage: (storedPath) => deletedImages.push(storedPath)
    })

    const result = service.merge({ targetId, sourceId })

    assert.equal(classificationQueryService.getDirector(targetId)?.imagePath, 'avatars/source.jpg')
    assert.equal(result.imagePath, 'avatars/source.jpg')
    assert.deepEqual(result.cleanupFailures, [])
    assert.deepEqual(deletedImages, [])
  })

  it('rolls back target fields and video relations when the database transaction fails', () => {
    setup()
    const targetId = classificationMaintenanceService.createDirector({
      mainName: 'Target',
      summary: 'Target summary'
    })
    const sourceId = classificationMaintenanceService.createDirector({
      mainName: 'Source',
      countryRegion: 'JP'
    })
    setImagePath(sourceId, 'avatars/source.jpg')
    const sourceVideoId = createVideo('DIR-ROLLBACK', sourceId)
    getDb().exec(`CREATE TRIGGER fail_director_merge BEFORE DELETE ON directors
      WHEN OLD.id = ${sourceId}
      BEGIN SELECT RAISE(ABORT, 'forced director merge failure'); END`)
    const deletedImages: string[] = []
    const service = createDirectorMergeService({
      deleteStoredImage: (storedPath) => deletedImages.push(storedPath)
    })

    assert.throws(
      () => service.merge({ targetId, sourceId }),
      /forced director merge failure/
    )

    assert.equal(classificationQueryService.getDirector(targetId)?.countryRegion, null)
    assert.equal(classificationQueryService.getDirector(sourceId)?.mainName, 'Source')
    assert.deepEqual(
      { directorId: getVideoById(sourceVideoId)?.director_id, director: getVideoById(sourceVideoId)?.director },
      { directorId: sourceId, director: 'Source' }
    )
    assert.deepEqual(deletedImages, [])
  })

  it('commits the merge and reports source portrait cleanup failure', () => {
    setup()
    const targetId = classificationMaintenanceService.createDirector({ mainName: 'Target' })
    const sourceId = classificationMaintenanceService.createDirector({ mainName: 'Source' })
    setImagePath(targetId, 'avatars/target.jpg')
    setImagePath(sourceId, 'avatars/source.jpg')
    const service = createDirectorMergeService({
      deleteStoredImage: () => {
        throw new Error('portrait locked')
      }
    })

    const result = service.merge({ targetId, sourceId })

    assert.equal(classificationQueryService.getDirector(sourceId), null)
    assert.equal(classificationQueryService.getDirector(targetId)?.imagePath, 'avatars/target.jpg')
    assert.deepEqual(result.cleanupFailures, [
      { path: 'avatars/source.jpg', error: 'portrait locked' }
    ])
  })

  it('rejects using the same director as target and source', () => {
    setup()
    const directorId = classificationMaintenanceService.createDirector({ mainName: 'Same' })

    assert.throws(
      () => directorMergeService.merge({ targetId: directorId, sourceId: directorId }),
      /不能合并同一导演/
    )
    assert.equal(classificationQueryService.getDirector(directorId)?.mainName, 'Same')
  })
})
