import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { getActressDetail } from '@library/db/actressRepo'
import { installScraperPluginPackage } from '../scrapers/scraperPluginService'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import { estimateActressBatchScrapeTargetCount } from './actressBatchScrapeTargets'
import { actressScrapeQueue } from './actressScrapeQueue'
import { resetBatchScrapeJobCache } from './batchScrapeJobStore'
import { createDefaultScrapeJobController } from './scrapeJobController'

const PLUGIN_NAME = 'Batch Target Profile Source'
const SCRAPED_BIRTH_DATE = '1992-03-04'

let tempRoot: string | null = null
let previousUserData: string | undefined

/** Actress ids by main name, seeded across every cumulative status and both genders. */
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

function scrapedNames(): string[] {
  return [...actressIds.keys()]
    .filter((name) => getActressDetail(id(name))?.birth_date === SCRAPED_BIRTH_DATE)
    .sort()
}

function startLog(): string {
  const [first] = actressScrapeQueue.getProgress().logs
  return first?.message ?? ''
}

beforeEach(async () => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-actress-scrape-queue-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  resetSettingsCacheForTests()
  resetBatchScrapeJobCache()
  createDefaultScrapeJobController({
    emit: () => undefined,
    rendererAvailable: () => false
  }).initialize()
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  actressIds.clear()
  seedActress('Queue Unscraped A', 'female', 0)
  seedActress('Queue Unscraped B', null, 0)
  seedActress('Queue Success', 'female', 1)
  seedActress('Queue Failed', 'male', 2)
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
})

afterEach(() => {
  closeDatabase()
  resetSettingsCacheForTests()
  resetBatchScrapeJobCache()
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  previousUserData = undefined
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('actressScrapeQueue.start target resolution', () => {
  it('scrapes exactly the targets the estimate reported for the same request', async () => {
    const estimate = estimateActressBatchScrapeTargetCount({
      scope: 'all',
      scrapeStatus: 'unscraped'
    })

    await actressScrapeQueue.start({
      scope: 'all',
      scrapeStatus: 'unscraped',
      fields: ['birthDate'],
      scraperName: PLUGIN_NAME,
      mode: 'replace'
    })

    assert.equal(estimate, 2)
    assert.equal(actressScrapeQueue.getProgress().total, estimate)
    assert.deepEqual(scrapedNames(), ['Queue Unscraped A', 'Queue Unscraped B'])
    assert.match(startLog(), /未刮削/)
  })

  it('starts a legacy scraped request against 刮削成功 targets', async () => {
    await actressScrapeQueue.start({
      scope: 'all',
      scrapeStatus: 'scraped',
      fields: ['birthDate'],
      scraperName: PLUGIN_NAME,
      mode: 'replace'
    } as never)

    assert.equal(actressScrapeQueue.getProgress().total, 1)
    assert.deepEqual(scrapedNames(), ['Queue Success'])
    assert.match(startLog(), /刮削成功/)
  })

  it('starts explicitly selected actresses regardless of the other filters', async () => {
    await actressScrapeQueue.start({
      actressIds: [id('Queue Failed'), id('Queue Failed'), 9999],
      scope: 'female',
      scrapeStatus: 'unscraped',
      missingFields: ['avatar'],
      fields: ['birthDate'],
      scraperName: PLUGIN_NAME,
      mode: 'replace'
    })

    assert.equal(actressScrapeQueue.getProgress().total, 1)
    assert.deepEqual(scrapedNames(), ['Queue Failed'])
    assert.match(startLog(), /已选 1 位演员/)
  })

  it('starts no target for an empty explicit id list', async () => {
    await actressScrapeQueue.start({
      actressIds: [],
      scope: 'all',
      scrapeStatus: 'all',
      fields: ['birthDate'],
      scraperName: PLUGIN_NAME,
      mode: 'replace'
    })

    assert.equal(actressScrapeQueue.getProgress().total, 0)
    assert.deepEqual(scrapedNames(), [])
  })

  it('refuses to start a request with an unknown cumulative-status scope', async () => {
    await assert.rejects(
      actressScrapeQueue.start({
        scope: 'all',
        scrapeStatus: 'everything',
        fields: ['birthDate'],
        scraperName: PLUGIN_NAME,
        mode: 'replace'
      } as never),
      /everything/
    )

    assert.deepEqual(scrapedNames(), [])
  })
})
