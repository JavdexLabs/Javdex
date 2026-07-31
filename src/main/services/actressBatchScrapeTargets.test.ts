import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import {
  estimateActressBatchScrapeTargetCount,
  normalizeActressBatchScrapeFilter,
  normalizeActressBatchScrapeRequest,
  normalizeActressBatchScrapeStatus,
  parseActressBatchScrapeStatus,
  reconcilePersistedActressBatchJob,
  resolveActressBatchScrapeTargets,
  type ActressBatchScrapeFilterInput
} from './actressBatchScrapeTargets'
import { createBatchScrapeJob } from './batchScrapeControl'
import type { PersistedBatchScrapeJob } from './batchScrapeJobStore'
import { ALL_ACTRESS_SCRAPE_FIELDS } from '@shared/types'

let tempRoot: string | null = null

/**
 * Fixture actresses covering every cumulative status, both genders, unknown gender
 * and a profile that is complete except for one field.
 */
function setupDb(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-actress-batch-targets-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  const db = getDb()
  const insert = db.prepare(
    `INSERT INTO actresses (main_name, gender, scraped_status, birth_date, height_cm)
     VALUES (?, ?, ?, ?, ?)`
  )
  insert.run('Alpha', 'female', 1, '1990-01-01', 160)
  insert.run('Bravo', 'female', 0, null, null)
  insert.run('Charlie', 'male', 2, null, null)
  insert.run('Delta', null, 2, '1992-02-02', 158)
  insert.run('Echo', 'female', 1, null, 165)
}

function targetNames(filter: ActressBatchScrapeFilterInput): string[] {
  return resolveActressBatchScrapeTargets(normalizeActressBatchScrapeFilter(filter)).map(
    (target) => target.main_name
  )
}

afterEach(() => {
  closeDatabase()
  delete process.env.JAVDEX_TEST_USER_DATA
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('actressBatchScrapeTargets status normalization', () => {
  it('keeps the four canonical cumulative-status scopes', () => {
    for (const scope of ['unscraped', 'success', 'failed', 'all'] as const) {
      assert.equal(normalizeActressBatchScrapeStatus(scope), scope)
    }
  })

  it('normalizes the legacy scraped scope to 刮削成功', () => {
    assert.equal(normalizeActressBatchScrapeStatus('scraped'), 'success')
  })

  it('normalizes an omitted scope to 全部', () => {
    assert.equal(normalizeActressBatchScrapeStatus(undefined), 'all')
  })

  it('rejects an unknown scope instead of widening the batch', () => {
    assert.throws(() => normalizeActressBatchScrapeStatus('everything'), /everything/)
  })

  it('reports unknown scopes without throwing for persisted job snapshots', () => {
    assert.deepEqual(parseActressBatchScrapeStatus('everything'), {
      ok: false,
      value: 'everything'
    })
    assert.deepEqual(parseActressBatchScrapeStatus('scraped'), { ok: true, status: 'success' })
  })

  it('never produces the legacy scope in a normalized request', () => {
    const request = normalizeActressBatchScrapeRequest({
      scope: 'female',
      scrapeStatus: 'scraped',
      fields: ALL_ACTRESS_SCRAPE_FIELDS
    })

    assert.equal(request.scrapeStatus, 'success')
  })
})

describe('reconcilePersistedActressBatchJob', () => {
  function pausedActressJob(scrapeStatus?: string): PersistedBatchScrapeJob {
    return {
      kind: 'actress',
      request: {
        scope: 'female',
        ...(scrapeStatus === undefined ? {} : { scrapeStatus }),
        fields: ['birthDate'],
        mode: 'replace'
      } as PersistedBatchScrapeJob['request'],
      targets: [
        { id: 1, label: 'One' },
        { id: 2, label: 'Two' }
      ],
      nextIndex: 1,
      success: 1,
      failed: 0,
      logs: [
        {
          time: '2026-01-01T00:00:00.000Z',
          code: '-',
          level: 'info',
          message: 'kept'
        }
      ],
      total: 2,
      status: 'paused',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
  }

  it('rewrites scraped to success and omitted to all without touching progress', () => {
    const scraped = reconcilePersistedActressBatchJob(pausedActressJob('scraped'))
    assert.equal(scraped.recoverable, true)
    assert.equal(scraped.rewritten, true)
    assert.equal(
      (scraped.job.request as { scrapeStatus?: string }).scrapeStatus,
      'success'
    )
    assert.equal(scraped.job.nextIndex, 1)
    assert.equal(scraped.job.success, 1)
    assert.deepEqual(scraped.job.targets.map((target) => target.id), [1, 2])

    const omitted = reconcilePersistedActressBatchJob(pausedActressJob(undefined))
    assert.equal(omitted.recoverable, true)
    assert.equal(omitted.rewritten, true)
    assert.equal((omitted.job.request as { scrapeStatus?: string }).scrapeStatus, 'all')
    assert.deepEqual(omitted.job.logs, pausedActressJob().logs)
  })

  it('keeps unrecognized scopes unrecoverable and does not widen to all', () => {
    const result = reconcilePersistedActressBatchJob(pausedActressJob('everything'))
    assert.equal(result.recoverable, false)
    if (result.recoverable) throw new Error('expected unrecoverable')
    assert.match(result.reason, /everything/)
    assert.equal(
      (result.job.request as { scrapeStatus?: string }).scrapeStatus,
      'everything'
    )
    assert.equal(result.job.nextIndex, 1)
  })
})

describe('actressBatchScrapeTargets resolution', () => {
  it('resolves each canonical cumulative-status scope', () => {
    setupDb()

    assert.deepEqual(targetNames({ scope: 'all', scrapeStatus: 'unscraped' }), ['Bravo'])
    assert.deepEqual(targetNames({ scope: 'all', scrapeStatus: 'success' }), ['Alpha', 'Echo'])
    assert.deepEqual(targetNames({ scope: 'all', scrapeStatus: 'failed' }), ['Charlie', 'Delta'])
    assert.deepEqual(targetNames({ scope: 'all', scrapeStatus: 'all' }), [
      'Alpha',
      'Bravo',
      'Charlie',
      'Delta',
      'Echo'
    ])
  })

  it('resolves the legacy scraped scope as 刮削成功 and an omitted scope as 全部', () => {
    setupDb()

    assert.deepEqual(targetNames({ scope: 'all', scrapeStatus: 'scraped' }), ['Alpha', 'Echo'])
    assert.equal(targetNames({ scope: 'all' }).length, 5)
  })

  it('intersects gender, cumulative status and missing fields', () => {
    setupDb()

    assert.deepEqual(
      targetNames({ scope: 'female', scrapeStatus: 'success', missingFields: ['birthDate'] }),
      ['Echo']
    )
    // Unknown gender counts as female, so Delta stays inside the female scope.
    assert.deepEqual(targetNames({ scope: 'female', scrapeStatus: 'all' }), [
      'Alpha',
      'Bravo',
      'Delta',
      'Echo'
    ])
    assert.deepEqual(targetNames({ scope: 'male', scrapeStatus: 'failed' }), ['Charlie'])
  })

  it('treats explicit ids as the whole target set, ignoring the other filters', () => {
    setupDb()

    assert.deepEqual(
      targetNames({
        actressIds: [3],
        scope: 'female',
        scrapeStatus: 'unscraped',
        missingFields: ['avatar']
      }),
      ['Charlie']
    )
  })

  it('deduplicates explicit ids and drops ids without a stored actress', () => {
    setupDb()

    assert.deepEqual(targetNames({ actressIds: [2, 2, 999], scope: 'all' }), ['Bravo'])
    assert.deepEqual(
      normalizeActressBatchScrapeFilter({ actressIds: [2, 2, 999], scope: 'all' }).actressIds,
      [2, 999]
    )
  })

  it('treats an empty explicit id list as zero targets', () => {
    setupDb()

    assert.deepEqual(targetNames({ actressIds: [], scope: 'all', scrapeStatus: 'all' }), [])
    assert.equal(estimateActressBatchScrapeTargetCount({ actressIds: [], scope: 'all' }), 0)
  })
})

describe('actressBatchScrapeTargets estimate and start', () => {
  it('estimates the count the start would resolve from the same request', () => {
    setupDb()
    const filter: ActressBatchScrapeFilterInput = { scope: 'female', scrapeStatus: 'scraped' }

    const estimate = estimateActressBatchScrapeTargetCount(filter)
    const started = resolveActressBatchScrapeTargets(
      normalizeActressBatchScrapeRequest({ ...filter, fields: ALL_ACTRESS_SCRAPE_FIELDS })
    )

    assert.equal(estimate, 2)
    assert.equal(started.length, estimate)
  })

  it('resolves targets again on start, so the total may differ from an earlier estimate', () => {
    setupDb()
    const filter: ActressBatchScrapeFilterInput = { scope: 'all', scrapeStatus: 'unscraped' }
    const estimate = estimateActressBatchScrapeTargetCount(filter)

    getDb()
      .prepare('INSERT INTO actresses (main_name, gender, scraped_status) VALUES (?, ?, 0)')
      .run('Foxtrot', 'female')

    assert.equal(estimate, 1)
    assert.deepEqual(targetNames(filter), ['Bravo', 'Foxtrot'])
  })

  it('freezes target ids, display names and total when the batch starts', () => {
    setupDb()
    const request = normalizeActressBatchScrapeRequest({
      scope: 'all',
      scrapeStatus: 'unscraped',
      fields: ALL_ACTRESS_SCRAPE_FIELDS
    })

    const job = createBatchScrapeJob(
      'actress',
      request,
      resolveActressBatchScrapeTargets(request),
      (target) => target.main_name
    )
    getDb().prepare('UPDATE actresses SET main_name = ? WHERE main_name = ?').run('Bravo 2', 'Bravo')
    getDb()
      .prepare('INSERT INTO actresses (main_name, gender, scraped_status) VALUES (?, ?, 0)')
      .run('Foxtrot', 'female')

    assert.deepEqual(job.targets, [{ id: 2, label: 'Bravo' }])
    assert.equal(job.total, 1)
  })
})
