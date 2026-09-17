import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { isStructuredError } from '@shared/protocol/errors'
import { normalizeActressName } from '@library/db/actressNameNormalization'
import { ensureCatalogIdentity } from './catalogIdentity'
import { classificationMaintenanceService } from './classificationMaintenanceService'
import { readActressAggregateVersion, readVideoAggregateVersion } from './catalogAggregateVersion'
import {
  applyActressScrapeCandidate,
  applyVideoScrapeCandidate,
  replacePendingVideoScrapeFromUploads,
  submitActressScrapeConflict
} from './catalogScrapeApply'
import { getPendingVideoScrapeForVideo } from '@library/db/pendingVideoScrapeRepo'
import { getActressDetail } from '@library/db/actressRepo'

let root: string | null = null

function setup(): ReturnType<typeof getDb> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-c6-scrape-apply-'))
  process.env.JAVDEX_TEST_USER_DATA = root
  initDatabaseAtPath(path.join(root, 'library.db'))
  ensureCatalogIdentity({ catalogId: randomUUID() })
  return getDb()
}

afterEach(() => {
  closeDatabase()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = null
  delete process.env.JAVDEX_TEST_USER_DATA
})

function insertVideo(code: string, title = 'Untitled'): number {
  return Number(getDb().prepare('INSERT INTO videos (code, title) VALUES (?, ?)').run(code, title).lastInsertRowid)
}

function insertActress(mainName: string): number {
  const db = getDb()
  const actressId = Number(db.prepare('INSERT INTO actresses (main_name) VALUES (?)').run(mainName).lastInsertRowid)
  db.prepare(
    "INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, 'main', 1)"
  ).run(actressId, mainName)
  db.prepare('INSERT INTO actress_name_ownership (normalized_name, actress_id) VALUES (?, ?)').run(
    normalizeActressName(mainName),
    actressId
  )
  return actressId
}

describe('catalog scrape apply (C6 unique/pending)', () => {
  it('applies a unique video candidate, requires Q when pending exists, and deletes pending on success', () => {
    setup()
    const videoId = insertVideo('C6-001', 'Old')
    const version = readVideoAggregateVersion(videoId)!
    const applied = applyVideoScrapeCandidate({
      videoId,
      fields: ['title'],
      mode: 'replace',
      candidate: { code: 'C6-001', title: 'New Title' },
      expected: { V: version },
      operationId: randomUUID()
    })
    assert.equal(applied.applied, true)
    assert.equal(
      (getDb().prepare('SELECT title FROM videos WHERE id = ?').get(videoId) as { title: string }).title,
      'New Title'
    )

    const afterApply = readVideoAggregateVersion(videoId)!
    const replaced = replacePendingVideoScrapeFromUploads({
      videoId,
      selectedFields: ['title'],
      applicableFields: ['title'],
      updateMode: 'replace',
      sources: [
        {
          pluginName: 'Test',
          pluginSource: 'builtin',
          sourceName: 'Test',
          selectedFields: ['title'],
          candidates: [{ result: { code: 'C6-001', title: 'Pending Title' } }]
        }
      ],
      expected: { V: afterApply },
      operationId: randomUUID()
    })
    assert.ok(replaced.pendingScrapeId > 0)
    assert.equal(getPendingVideoScrapeForVideo(videoId)?.id, replaced.pendingScrapeId)

    assert.throws(
      () =>
        applyVideoScrapeCandidate({
          videoId,
          fields: ['title'],
          mode: 'replace',
          candidate: { code: 'C6-001', title: 'Should Fail' },
          expected: { V: afterApply },
          operationId: randomUUID()
        }),
      (error: unknown) => isStructuredError(error) && error.message.includes('待确认操作需要 Q 版本')
    )

    const confirmed = applyVideoScrapeCandidate({
      videoId,
      fields: ['title'],
      mode: 'replace',
      candidate: { code: 'C6-001', title: 'Confirmed Title' },
      expected: { V: afterApply, Q: replaced.versions.Q },
      operationId: randomUUID()
    })
    assert.equal(confirmed.applied, true)
    assert.equal(getPendingVideoScrapeForVideo(videoId), null)
    assert.equal(
      (getDb().prepare('SELECT title FROM videos WHERE id = ?').get(videoId) as { title: string }).title,
      'Confirmed Title'
    )
  })

  it('rejects a unique apply that would collide on business identity', () => {
    setup()
    const publisherId = classificationMaintenanceService.createOrganization({
      mainName: 'C6 Studio',
      role: 'publisher'
    })
    const keptId = insertVideo('C6-DUP')
    getDb()
      .prepare('UPDATE videos SET publisher_organization_id = ?, release_date = ? WHERE id = ?')
      .run(publisherId, '2020-01-01', keptId)
    const targetId = insertVideo('C6-DUP')
    const version = readVideoAggregateVersion(targetId)!
    assert.throws(
      () =>
        applyVideoScrapeCandidate({
          videoId: targetId,
          fields: ['publisher', 'releaseDate'],
          mode: 'replace',
          candidate: {
            code: 'C6-DUP',
            publisher: 'C6 Studio',
            releaseDate: '2020-01-01'
          },
          expected: { V: version },
          operationId: randomUUID()
        }),
      (error: unknown) =>
        isStructuredError(error) &&
        error.code === 'IDENTITY_CONFLICT' &&
        error.message.includes('业务身份冲突')
    )
    assert.equal(
      (
        getDb().prepare('SELECT publisher_organization_id FROM videos WHERE id = ?').get(targetId) as {
          publisher_organization_id: number | null
        }
      ).publisher_organization_id,
      null
    )
  })

  it('returns director choice without writing when ambiguity is choice', () => {
    setup()
    const videoId = insertVideo('C6-DIR', 'Keep')
    classificationMaintenanceService.createDirector({
      mainName: 'Shared Director',
      countryRegion: 'JP',
      birthDate: '1960-01-01'
    })
    classificationMaintenanceService.createDirector({
      mainName: 'Ｓｈａｒｅｄ　Ｄｉｒｅｃｔｏｒ',
      countryRegion: 'US',
      birthDate: '1980-01-01'
    })
    const version = readVideoAggregateVersion(videoId)!
    const outcome = applyVideoScrapeCandidate({
      videoId,
      fields: ['title', 'director'],
      mode: 'replace',
      candidate: { code: 'C6-DIR', title: 'Changed', director: 'Shared Director' },
      directorAmbiguity: 'choice',
      expected: { V: version },
      operationId: randomUUID()
    })
    assert.equal(outcome.applied, false)
    assert.equal(outcome.directorChoice?.scrapedName, 'Shared Director')
    assert.equal(outcome.directorChoice?.candidates.length, 2)
    assert.equal(
      (getDb().prepare('SELECT title FROM videos WHERE id = ?').get(videoId) as { title: string }).title,
      'Keep'
    )
  })

  it('applies a unique actress candidate and routes name conflicts to submit', () => {
    setup()
    const actressId = insertActress('C6 One')
    const otherId = insertActress('C6 Two')
    const version = readActressAggregateVersion(actressId)!
    const applied = applyActressScrapeCandidate({
      actressId,
      candidate: { nameZh: '中文名' },
      fields: ['nameZh'],
      mode: 'replace',
      expected: { A: version },
      operationId: randomUUID()
    })
    assert.equal(applied.applied, true)
    assert.equal(getActressDetail(actressId)?.name_zh, '中文名')

    const after = readActressAggregateVersion(actressId)!
    assert.throws(
      () =>
        applyActressScrapeCandidate({
          actressId,
          candidate: { aliases: ['C6 Two'] },
          fields: ['aliases'],
          mode: 'replace',
          expected: { A: after },
          operationId: randomUUID()
        }),
      (error: unknown) => isStructuredError(error) && error.message.includes('名称归属冲突')
    )

    const submitted = submitActressScrapeConflict({
      actressId,
      pluginName: 'Test',
      pluginSource: 'builtin',
      queryName: 'C6 One',
      selectedFields: ['aliases'],
      applicableFields: ['aliases'],
      mode: 'replace',
      candidate: { aliases: ['C6 Two'] },
      expected: { A: after },
      operationId: randomUUID()
    })
    assert.ok(submitted.pendingId > 0)
    const pending = getDb()
      .prepare('SELECT actress_id FROM pending_actress_scrapes WHERE id = ?')
      .get(submitted.pendingId) as { actress_id: number } | undefined
    assert.equal(pending?.actress_id, actressId)
    assert.equal(otherId > 0, true)
  })
})
