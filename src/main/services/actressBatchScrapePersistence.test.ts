import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { editActress, getActressDetail } from '../db/actressRepo'
import { actressIdentityConflictWorkflow } from '../scrapers/actressScraperManager'
import { installScraperPluginPackage } from '../scrapers/scraperPluginService'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import { actressScrapeQueue } from './actressScrapeQueue'
import { getBatchScrapeState } from './batchScrapeControl'
import {
  loadBatchScrapeJob,
  resetBatchScrapeJobCache,
  saveBatchScrapeJob,
  type PersistedBatchScrapeJob
} from './batchScrapeJobStore'

const PLUGIN_NAME = 'Persistence Profile Source'
const PENDING_PLUGIN_NAME = 'Persistence Conflict Source'
const SCRAPED_BIRTH_DATE = '1991-05-06'

let tempRoot: string | null = null
let previousUserData: string | undefined
const actressIds = new Map<string, number>()

function seedActress(mainName: string, gender: string | null, status: number): void {
  const inserted = getDb()
    .prepare('INSERT INTO actresses (main_name, gender, scraped_status) VALUES (?, ?, ?)')
    .run(mainName, gender, status)
  actressIds.set(mainName, Number(inserted.lastInsertRowid))
}

function id(mainName: string): number {
  const value = actressIds.get(mainName)
  assert.ok(value, `unknown fixture actress ${mainName}`)
  return value
}

function jobFilePath(): string {
  assert.ok(tempRoot)
  return path.join(tempRoot, 'batch-scrape-job.json')
}

function readJobFile(): PersistedBatchScrapeJob {
  return JSON.parse(fs.readFileSync(jobFilePath(), 'utf-8')) as PersistedBatchScrapeJob
}

function writePausedActressJob(
  overrides: Partial<PersistedBatchScrapeJob> = {}
): PersistedBatchScrapeJob {
  const job: PersistedBatchScrapeJob = {
    jobId: '00000000-0000-4000-8000-000000000001',
    kind: 'actress',
    request: {
      scope: 'female',
      scrapeStatus: 'unscraped',
      fields: ['birthDate'],
      scraperName: PLUGIN_NAME,
      mode: 'replace'
    },
    targets: [
      { id: id('Persist A'), label: 'Persist A' },
      { id: id('Persist B'), label: 'Persist B' }
    ],
    nextIndex: 1,
    success: 1,
    pending: 0,
    failed: 0,
    logs: [
      {
        time: '2026-01-01T00:00:00.000Z',
        code: '-',
        level: 'info',
        message: 'checkpoint'
      }
    ],
    total: 2,
    status: 'paused',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
  fs.writeFileSync(jobFilePath(), JSON.stringify(job, null, 2), 'utf-8')
  resetBatchScrapeJobCache()
  return job
}

function scrapedNames(): string[] {
  return [...actressIds.keys()]
    .filter((name) => getActressDetail(id(name))?.birth_date === SCRAPED_BIRTH_DATE)
    .sort()
}

beforeEach(async () => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-actress-batch-persist-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  resetSettingsCacheForTests()
  resetBatchScrapeJobCache()
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  actressIds.clear()
  seedActress('Persist A', 'female', 0)
  seedActress('Persist B', 'female', 0)
  seedActress('Persist Success', 'female', 1)
  seedActress('Persist Outside', 'male', 0)
  seedActress('Conflict Owner', 'female', 1)
  editActress(id('Conflict Owner'), {
    main_name: 'Conflict Owner',
    aliases: ['Collision']
  })
  await installScraperPluginPackage({
    schemaVersion: 1,
    kind: 'actress',
    name: PLUGIN_NAME,
    version: '1.0.0',
    description: 'Returns one valid profile field',
    supportedFields: ['birthDate'],
    code: `
module.exports = {
  async parseActress() {
    return { birthDate: '${SCRAPED_BIRTH_DATE}' };
  }
};
`
  })
  await installScraperPluginPackage({
    schemaVersion: 1,
    kind: 'actress',
    name: PENDING_PLUGIN_NAME,
    version: '1.0.0',
    description: 'Returns a conflicting alias',
    supportedFields: ['aliases'],
    code: `
module.exports = {
  async parseActress() {
    return { aliases: ['Collision'] };
  }
};
`
  })
})

afterEach(() => {
  actressScrapeQueue.setListener(null)
  if (actressScrapeQueue.isPaused()) actressScrapeQueue.discard()
  closeDatabase()
  resetSettingsCacheForTests()
  resetBatchScrapeJobCache()
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  previousUserData = undefined
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('actress batch scrape persistence lifecycle', () => {
  it('persists one stable job id and advances pending targets across restart', async () => {
    let pauseRequested = false
    actressScrapeQueue.setListener((progress) => {
      if (pauseRequested) return
      if (progress.current >= 1 && progress.status === 'running') {
        pauseRequested = true
        actressScrapeQueue.pause()
      }
    })

    await actressScrapeQueue.start({
      actressIds: [id('Persist A'), id('Persist B')],
      scope: 'all',
      scrapeStatus: 'all',
      fields: ['aliases'],
      scraperName: PENDING_PLUGIN_NAME,
      mode: 'replace'
    })

    const pausedJob = readJobFile()
    assert.match(pausedJob.jobId, /^[0-9a-f-]{36}$/i)
    assert.equal(pausedJob.nextIndex, 1)
    assert.deepEqual(
      {
        success: pausedJob.success,
        pending: pausedJob.pending,
        failed: pausedJob.failed
      },
      { success: 0, pending: 1, failed: 0 }
    )
    const firstCandidate = actressIdentityConflictWorkflow
      .listConflictGroups()[0]
      .candidates.find((candidate) => candidate.actressId === id('Persist A'))!
    assert.equal(firstCandidate.batchJobId, pausedJob.jobId)

    actressScrapeQueue.setListener(null)
    resetBatchScrapeJobCache()
    await actressScrapeQueue.resume()

    assert.equal(loadBatchScrapeJob(), null)
    assert.equal(fs.existsSync(jobFilePath()), false)
    assert.deepEqual(
      {
        current: actressScrapeQueue.getProgress().current,
        success: actressScrapeQueue.getProgress().success,
        pending: actressScrapeQueue.getProgress().pending,
        failed: actressScrapeQueue.getProgress().failed
      },
      { current: 2, success: 0, pending: 2, failed: 0 }
    )
    assert.ok(
      actressScrapeQueue
        .getProgress()
        .logs.some((entry) =>
          entry.message.includes('批量刮削完成：成功 0，待确认 2，失败 0')
        )
    )
    const candidates = actressIdentityConflictWorkflow
      .listConflictGroups()[0]
      .candidates.sort((a, b) => a.actressId - b.actressId)
    assert.deepEqual(
      candidates.map((candidate) => ({
        actressId: candidate.actressId,
        batchJobId: candidate.batchJobId
      })),
      [
        { actressId: id('Persist A'), batchJobId: pausedJob.jobId },
        { actressId: id('Persist B'), batchJobId: pausedJob.jobId }
      ]
    )
    assert.equal(
      candidates.find((candidate) => candidate.actressId === id('Persist A'))?.pendingId,
      firstCandidate.pendingId
    )

    actressIdentityConflictWorkflow.discardPendingScrape({
      pendingId: firstCandidate.pendingId,
      expectedRevision: firstCandidate.revision
    })
    assert.equal(actressIdentityConflictWorkflow.countPendingScrapes(), 1)
    assert.equal(actressScrapeQueue.getProgress().pending, 2)
  })

  it('loads a legacy task without tri-state fields using a stable fallback job id', async () => {
    const saved = writePausedActressJob()
    const {
      jobId: _jobId,
      pending: _pending,
      updatedAt: _updatedAt,
      ...legacyJob
    } = saved
    fs.writeFileSync(jobFilePath(), JSON.stringify(legacyJob), 'utf-8')

    resetBatchScrapeJobCache()
    const first = loadBatchScrapeJob()
    await new Promise((resolve) => setTimeout(resolve, 5))
    resetBatchScrapeJobCache()
    const second = loadBatchScrapeJob()

    assert.equal(first?.pending, 0)
    assert.equal(second?.pending, 0)
    assert.equal(second?.jobId, first?.jobId)
  })

  it('clears a cancelled task file without deleting its completed pending result', async () => {
    let cancelRequested = false
    actressScrapeQueue.setListener((progress) => {
      if (cancelRequested) return
      if (progress.current >= 1 && progress.status === 'running') {
        cancelRequested = true
        actressScrapeQueue.discard()
      }
    })

    await actressScrapeQueue.start({
      actressIds: [id('Persist A'), id('Persist B')],
      scope: 'all',
      scrapeStatus: 'all',
      fields: ['aliases'],
      scraperName: PENDING_PLUGIN_NAME,
      mode: 'replace'
    })

    assert.equal(fs.existsSync(jobFilePath()), false)
    assert.equal(loadBatchScrapeJob(), null)
    assert.equal(actressScrapeQueue.getProgress().status, 'idle')
    assert.equal(actressIdentityConflictWorkflow.countPendingScrapes(), 1)
    assert.match(
      actressIdentityConflictWorkflow.listConflictGroups()[0].candidates[0].batchJobId ?? '',
      /^[0-9a-f-]{36}$/i
    )
  })

  it('persists only a canonical status and the start-time target snapshot', async () => {
    // Pause after the first target finishes so a checkpoint lands on disk.
    let pauseRequested = false
    actressScrapeQueue.setListener((progress) => {
      if (pauseRequested) return
      if (progress.current >= 1 && progress.status === 'running') {
        pauseRequested = true
        actressScrapeQueue.pause()
      }
    })

    await actressScrapeQueue.start({
      scope: 'female',
      scrapeStatus: 'unscraped',
      fields: ['birthDate'],
      scraperName: PLUGIN_NAME,
      mode: 'replace'
    })

    const job = readJobFile()
    assert.equal(job.kind, 'actress')
    assert.equal((job.request as { scrapeStatus?: string }).scrapeStatus, 'unscraped')
    assert.deepEqual(
      job.targets.map((target) => target.label).sort(),
      ['Persist A', 'Persist B']
    )
    assert.equal(job.total, 2)
    assert.equal(job.nextIndex, 1)
    assert.equal(job.success + job.pending + job.failed, 1)
    assert.equal(job.status, 'paused')
    actressScrapeQueue.setListener(null)
  })

  it('recovers a paused checkpoint after an application restart cache reset', async () => {
    writePausedActressJob({})
    resetBatchScrapeJobCache()

    const state = getBatchScrapeState()
    assert.equal(state.kind, 'actress')
    assert.equal(state.recoverable, true)
    assert.equal(state.progress?.status, 'paused')
    assert.equal(state.progress?.current, 1)
    assert.equal(state.progress?.success, 1)
    assert.equal(state.progress?.total, 2)
    assert.equal(state.progress?.logs.length, 1)
  })

  it('normalizes a legacy scraped paused job without rewriting progress', () => {
    const seeded = writePausedActressJob({
      request: {
        scope: 'all',
        scrapeStatus: 'scraped',
        fields: ['birthDate'],
        scraperName: PLUGIN_NAME,
        mode: 'replace'
      } as never
    })

    const state = getBatchScrapeState()
    const onDisk = readJobFile()

    assert.equal(state.recoverable, true)
    assert.equal((onDisk.request as { scrapeStatus?: string }).scrapeStatus, 'success')
    assert.deepEqual(onDisk.targets, seeded.targets)
    assert.equal(onDisk.total, seeded.total)
    assert.equal(onDisk.nextIndex, seeded.nextIndex)
    assert.equal(onDisk.success, seeded.success)
    assert.equal(onDisk.failed, seeded.failed)
    assert.deepEqual(onDisk.logs, seeded.logs)
  })

  it('normalizes an omitted scrapeStatus to all while preserving the snapshot', () => {
    const seeded = writePausedActressJob({
      request: {
        scope: 'female',
        fields: ['birthDate'],
        scraperName: PLUGIN_NAME,
        mode: 'replace'
      } as PersistedBatchScrapeJob['request']
    })

    const state = getBatchScrapeState()
    const onDisk = readJobFile()

    assert.equal(state.recoverable, true)
    assert.equal((onDisk.request as { scrapeStatus?: string }).scrapeStatus, 'all')
    assert.equal(onDisk.nextIndex, seeded.nextIndex)
    assert.equal(onDisk.success, seeded.success)
    assert.deepEqual(onDisk.targets, seeded.targets)
  })

  it('marks an unknown status job unrecoverable without falling back to all', () => {
    writePausedActressJob({
      request: {
        scope: 'female',
        scrapeStatus: 'everything',
        fields: ['birthDate'],
        scraperName: PLUGIN_NAME,
        mode: 'replace'
      } as never
    })

    const state = getBatchScrapeState()
    const onDisk = readJobFile()

    assert.equal(state.kind, 'actress')
    assert.equal(state.recoverable, false)
    assert.match(state.unrecoverableReason ?? '', /everything/)
    assert.equal(state.progress?.status, 'paused')
    assert.equal(state.progress?.current, 1)
    assert.equal((onDisk.request as { scrapeStatus?: string }).scrapeStatus, 'everything')
  })

  it('blocks resume for an unknown status job but still allows discard', async () => {
    writePausedActressJob({
      request: {
        scope: 'female',
        scrapeStatus: 'everything',
        fields: ['birthDate'],
        scraperName: PLUGIN_NAME,
        mode: 'replace'
      } as never
    })

    await assert.rejects(actressScrapeQueue.resume(), /everything/)
    assert.equal(fs.existsSync(jobFilePath()), true)

    actressScrapeQueue.discard()
    resetBatchScrapeJobCache()

    assert.equal(fs.existsSync(jobFilePath()), false)
    const state = getBatchScrapeState()
    assert.equal(state.kind, null)
    assert.equal(state.progress, null)
    assert.equal(state.recoverable, true)
  })

  it('resumes from the saved snapshot without re-applying current filters', async () => {
    writePausedActressJob({})

    // Mutate live filters: flip gender/status so a fresh resolve would exclude both targets.
    getDb()
      .prepare('UPDATE actresses SET gender = ?, scraped_status = ? WHERE id = ?')
      .run('male', 1, id('Persist A'))
    getDb()
      .prepare('UPDATE actresses SET gender = ?, scraped_status = ? WHERE id = ?')
      .run('male', 1, id('Persist B'))

    await actressScrapeQueue.resume()

    // Checkpoint was at nextIndex 1, so only the remaining snapshot target is scraped.
    assert.deepEqual(scrapedNames(), ['Persist B'])
    assert.equal(loadBatchScrapeJob(), null)
    assert.equal(actressScrapeQueue.getProgress().status, 'done')
    assert.equal(actressScrapeQueue.getProgress().success, 2)
  })

  it('resumes a normalized legacy scraped job with unified scrape result semantics', async () => {
    writePausedActressJob({
      request: {
        scope: 'all',
        scrapeStatus: 'scraped',
        fields: ['birthDate'],
        scraperName: PLUGIN_NAME,
        mode: 'replace'
      } as never,
      targets: [
        { id: id('Persist A'), label: 'Persist A' },
        { id: id('Persist Success'), label: 'Persist Success' }
      ],
      total: 2,
      nextIndex: 1,
      success: 1,
      failed: 0
    })

    await actressScrapeQueue.resume()

    assert.ok(scrapedNames().includes('Persist Success'))
    const state = getBatchScrapeState()
    assert.equal(state.kind, null)
    assert.equal(getActressDetail(id('Persist Success'))?.scraped_status, 1)
  })
})
