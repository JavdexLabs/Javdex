import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { getVideoById } from '../db/videoRepo'
import { classificationMaintenanceService } from './classificationMaintenanceService'
import { classificationQueryService } from './classificationQueryService'

function withDatabase(run: () => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-directors-'))
  try {
    initDatabaseAtPath(path.join(tempDir, 'library.db'))
    run()
  } finally {
    closeDatabase()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('classification director query and maintenance services', () => {
  it('keeps real same-name directors as separate stable identities and exposes candidate differences', () => {
    withDatabase(() => {
      const first = classificationMaintenanceService.createDirector({
        mainName: 'Alex Lee',
        aliases: ['A. Lee'],
        countryRegion: 'US',
        birthDate: '1970-01-02',
      })
      const second = classificationMaintenanceService.createDirector({
        mainName: 'Ａｌｅｘ Ｌｅｅ',
        countryRegion: 'HK',
        birthDate: '1985-03-04',
      })
      const options = classificationQueryService.listDirectorOptions('alexlee')
      assert.deepEqual(
        options.map((item) => item.id),
        [first, second],
      )
      assert.deepEqual(
        options.map((item) => item.countryRegion),
        ['US', 'HK'],
      )
    })
  })

  it('maintains the complete profile without changing identity or video relations', () => {
    withDatabase(() => {
      const id = classificationMaintenanceService.createDirector({
        mainName: 'Before',
      })
      const videoId = Number(
        getDb()
          .prepare(
            "INSERT INTO videos (code, release_date, cover_path) VALUES ('DIR-1', '2022-01-01', 'covers/dir.jpg')",
          )
          .run().lastInsertRowid,
      )
      classificationMaintenanceService.assignVideoDirector(videoId, {
        directorId: id,
      })
      classificationMaintenanceService.updateDirector(id, {
        mainName: 'After',
        keepPreviousMainName: true,
        aliases: ['Alias'],
        summary: 'Line 1\nLine 2',
        countryRegion: 'JP',
        birthDate: '1960-01-01',
        deathDate: '2024-01-01',
        birthPlace: 'Tokyo',
        careerStartYear: 1980,
        careerEndYear: 2020,
        status: 'deceased',
        links: [{ label: '', url: 'https://example.com/director' }],
      })
      const detail = classificationQueryService.getDirector(id)
      assert.equal(detail?.mainName, 'After')
      assert.deepEqual(detail?.aliases, ['Before', 'Alias'])
      assert.equal(detail?.videoCount, 1)
      assert.equal(detail?.releaseYearStart, 2022)
      assert.equal(detail?.fallbackCoverPath, 'covers/dir.jpg')
      assert.equal(detail?.links[0]?.label, 'example.com')
      assert.deepEqual(
        { directorId: getVideoById(videoId)?.director_id, director: getVideoById(videoId)?.director },
        { directorId: id, director: 'After' }
      )
    })
  })

  it('validates calendar dates and career ranges transactionally', () => {
    withDatabase(() => {
      assert.throws(
        () =>
          classificationMaintenanceService.createDirector({
            mainName: 'Invalid',
            birthDate: '2024-02-30',
          }),
        /有效日期/,
      )
      assert.throws(
        () =>
          classificationMaintenanceService.createDirector({
            mainName: 'Invalid range',
            careerStartYear: 2020,
            careerEndYear: 2000,
          }),
        /不能晚于/,
      )
      assert.equal(classificationQueryService.listDirectors({}).length, 0)
    })
  })

  it('searches aliases and supports only count or update sorting in both directions', () => {
    withDatabase(() => {
      const older = classificationMaintenanceService.createDirector({
        mainName: 'Older',
        aliases: ['Needle'],
      })
      const newer = classificationMaintenanceService.createDirector({
        mainName: 'Newer',
      })
      const videoId = Number(
        getDb().prepare("INSERT INTO videos (code) VALUES ('DIR-SORT')").run().lastInsertRowid,
      )
      classificationMaintenanceService.assignVideoDirector(videoId, {
        directorId: older,
      })
      getDb().prepare('UPDATE directors SET updated_at = ? WHERE id = ?').run('2020-01-01', older)
      getDb().prepare('UPDATE directors SET updated_at = ? WHERE id = ?').run('2025-01-01', newer)
      assert.deepEqual(
        classificationQueryService.listDirectors({ search: 'needle' }).map((item) => item.id),
        [older],
      )
      assert.deepEqual(
        classificationQueryService
          .listDirectors({ sortBy: 'updated_at', sortDir: 'desc' })
          .map((item) => item.id),
        [newer, older],
      )
      assert.deepEqual(
        classificationQueryService
          .listDirectors({ sortBy: 'video_count', sortDir: 'asc' })
          .map((item) => item.id),
        [newer, older],
      )
    })
  })
})
