import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabaseAtPath, closeDatabase, getDb } from '../db/database'
import { insertTestVideoWithFile } from '../db/testVideoFixtures'
import { createDefaultLocalNfoSourceAdapter, getDefaultNfoFileStore, type VideoMetadataCandidate } from '../metadata-sources'
import { createLocalNfoScanService } from './localNfoScanService'
import { createVideoScrapeApplyService } from './videoScrapeApplyService'
import { mediaAssetStore } from './mediaAssetStore'

const JPEG_1X1 = Buffer.from(
  'ffd8ffdb00430006040506050406060506070706080a100a0a09090a140e0f0c1017141818171416161a1d251f1a1b231c1616202c20232627292a29191f2d302d283025282928ffdb0043010707070a080a130a0a13281a161a2828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828ffc00011080001000103012200021101031101ffc40014000100000000000000000000000000000000ffc40014100100000000000000000000000000000000ffc40014010100000000000000000000000000000000ffc40014110100000000000000000000000000000000ffda000c03010002110311003f00000fffd9',
  'hex'
)

let directory: string
let videoId: number
let previousUserData: string | undefined
const originalStage = mediaAssetStore.stageVideoScrapeImages
const originalCleanup = mediaAssetStore.cleanupVideoScrapeStagingPaths
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-nfo-transaction-'))
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = directory
  const db = initDatabaseAtPath(path.join(directory, 'catalog.db'))
  insertTestVideoWithFile(db, { code: 'NFO-001', filePath: '/synthetic/NFO-001.mp4', scrapedStatus: 0 })
  videoId = (db.prepare("SELECT id FROM videos WHERE code='NFO-001'").get() as { id: number }).id
  db.exec('CREATE TABLE test_nfo_audit (outcome TEXT NOT NULL)')
})
afterEach(() => {
  mediaAssetStore.stageVideoScrapeImages = originalStage
  mediaAssetStore.cleanupVideoScrapeStagingPaths = originalCleanup
  closeDatabase()
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  fs.rmSync(directory, { recursive: true, force: true })
})
function candidate(title: string): VideoMetadataCandidate {
  return { result: { code: 'NFO-001', title, summary: 'NFO summary' }, assets: [],
    evidence: { kind: 'local-nfo', sourceId: 'local-nfo', sourceName: 'local-nfo' } }
}
function service(count = 1) {
  const source = createDefaultLocalNfoSourceAdapter(getDefaultNfoFileStore())
  source.inspectIdentity = () => ({ status: 'found', code: 'NFO-001', warnings: [] })
  source.collectFromAnchors = async () => ({
    candidates: Array.from({ length: count }, (_, i) => candidate(`Title ${i}`)),
    warnings: ['collected warning']
  })
  return createLocalNfoScanService(source)
}

function pendingSnapshot() {
  return ['pending_video_scrapes', 'pending_video_scrape_sources', 'pending_video_scrape_candidates', 'pending_video_scrape_resources']
    .map((table) => getDb().prepare(`SELECT * FROM ${table} ORDER BY id`).all())
}
function videoSnapshot() { return getDb().prepare('SELECT * FROM videos WHERE id=?').get(videoId) }

it('rolls back actual ordinary NFO writes and callback writes, then retries successfully', async () => {
  const nfo = service(), db = getDb(), before = videoSnapshot()
  const failure = new Error('audit failed')
  await assert.rejects(nfo.apply(videoId, 'NFO-001', [], (result) => {
    assert.equal(db.inTransaction, true)
    assert.equal(result.disposition, 'imported')
    assert.ok(result.warnings.includes('collected warning'))
    assert.equal((db.prepare('SELECT title FROM videos WHERE id=?').get(videoId) as { title: string }).title, 'Title 0')
    db.prepare('INSERT INTO test_nfo_audit VALUES(?)').run(result.disposition)
    throw failure
  }), (error) => error === failure)
  assert.deepEqual(videoSnapshot(), before)
  assert.deepEqual(db.prepare('SELECT * FROM test_nfo_audit').all(), [])
  let calls = 0
  const result = await nfo.apply(videoId, 'NFO-001', [], (outcome) => {
    calls++
    assert.equal(db.inTransaction, true)
    db.prepare('INSERT INTO test_nfo_audit VALUES(?)').run(outcome.disposition)
  })
  assert.equal(calls, 1)
  assert.equal(result.disposition, 'imported')
  assert.deepEqual(db.prepare('SELECT * FROM test_nfo_audit').all(), [{ outcome: 'imported' }])
  assert.equal((videoSnapshot() as { scraped_status: number }).scraped_status, 1)
})

it('rolls back actual pending replacement, retains restored old assets, cleans new staging and retries', async () => {
  const nfo = service(2), db = getDb()
  const created: string[] = []
  mediaAssetStore.stageVideoScrapeImages = (() => {
    assert.equal(db.inTransaction, false)
    const staged = originalStage.call(mediaAssetStore, [
      { field: 'cover', position: 0, remoteUrl: '', data: JPEG_1X1 }
    ])
    created.push(...staged.map((resource) => resource.stagedPath))
    return staged
  }) as typeof mediaAssetStore.stageVideoScrapeImages
  const exists = (storedPath: string) => fs.existsSync(mediaAssetStore.resolve(storedPath))
  await nfo.apply(videoId, 'NFO-001', [])
  const before = pendingSnapshot()
  const [oldA, oldB] = created
  await assert.rejects(nfo.apply(videoId, 'NFO-001', [], (result) => {
    assert.equal(db.inTransaction, true)
    assert.equal(result.disposition, 'pending-candidate')
    assert.ok(result.pendingScrapeId)
    assert.ok(exists(oldA))
    db.prepare('INSERT INTO test_nfo_audit VALUES(?)').run(result.disposition)
    throw new Error('pending audit failed')
  }), /pending audit failed/)
  assert.deepEqual(pendingSnapshot(), before)
  assert.deepEqual(db.prepare('SELECT * FROM test_nfo_audit').all(), [])
  assert.equal(created.length, 4)
  assert.equal(exists(created[2]), false)
  assert.equal(exists(created[3]), false)
  assert.equal(exists(oldA), true)
  assert.equal(exists(oldB), true)
  const result = await nfo.apply(videoId, 'NFO-001', [], (outcome) => {
    assert.equal(db.inTransaction, true)
    assert.equal(exists(oldA), true)
    db.prepare('INSERT INTO test_nfo_audit VALUES(?)').run(outcome.disposition)
  })
  assert.equal(result.disposition, 'pending-candidate')
  assert.equal(exists(oldA), false)
  assert.equal(exists(oldB), false)
  assert.equal(exists(created[4]), true)
  assert.equal(exists(created[5]), true)
  assert.deepEqual(db.prepare('SELECT * FROM test_nfo_audit').all(), [{ outcome: 'pending-candidate' }])
})

for (const count of [1, 2]) for (const rejected of [false, true]) {
  it(`rejects ${rejected ? 'rejected' : 'resolved'} async callbacks and rolls back ${count === 1 ? 'ordinary' : 'pending'} synchronous writes`, async () => {
    const nfo = service(count), db = getDb(), beforeVideo = videoSnapshot(), beforePending = pendingSnapshot()
    await assert.rejects(nfo.apply(videoId, 'NFO-001', [], async (result) => {
      db.prepare('INSERT INTO test_nfo_audit VALUES(?)').run(result.disposition)
      if (rejected) throw new Error('rejected async callback')
    }), /must be synchronous/)
    assert.deepEqual(videoSnapshot(), beforeVideo)
    assert.deepEqual(pendingSnapshot(), beforePending)
    assert.deepEqual(db.prepare('SELECT * FROM test_nfo_audit').all(), [])
    assert.equal((await nfo.apply(videoId, 'NFO-001', [])).disposition, count === 1 ? 'imported' : 'pending-candidate')
  })
}

it('notifies no-write outcomes synchronously and propagates callback failure', async () => {
  let calls = 0
  await assert.rejects(service().apply(-1, 'missing', [], (result) => {
    calls++
    assert.equal(getDb().inTransaction, false)
    assert.equal(result.disposition, 'warning')
    throw new Error('no-write audit failure')
  }), /no-write audit failure/)
  assert.equal(calls, 1)
})

it('deliver outcome callback precedes obsolete deletion and rolls back while preserving afterSuccessfulApply', async () => {
  const db = getDb(), deleted: string[] = [], before = videoSnapshot()
  const delivery = createVideoScrapeApplyService({
    coordinateDatabaseChange: ((operation: () => unknown) => operation()) as typeof mediaAssetStore.coordinateDatabaseChange,
    deleteBestEffort: (asset) => { if (asset) deleted.push(asset) },
    apply: () => {
      db.prepare("UPDATE videos SET title='applied' WHERE id=?").run(videoId)
      return { applied: true, warnings: ['initial'], obsoleteAssetPaths: ['old-cover'], classifications: [] }
    }
  })
  const input = { videoId, code: 'NFO-001', candidate: candidate('Title'), selectedFields: [], fieldsToApply: [], mode: 'fillEmpty' as const,
    candidateStager: { stageForPending: async () => ({ candidates: [], warnings: [] }),
      deliverForApply: async () => ({ coverRel: 'new-cover', sampleRels: [], avatarMap: new Map<string, string | null>() }) },
    afterSuccessfulApply: () => { db.prepare("INSERT INTO test_nfo_audit VALUES('after')").run() } }
  await assert.rejects(delivery.deliverCandidate({ ...input, beforeCommit: (result) => {
    assert.equal(db.inTransaction, true)
    assert.deepEqual(result.warnings, ['initial'])
    assert.deepEqual(deleted, [])
    assert.deepEqual(db.prepare('SELECT * FROM test_nfo_audit').all(), [{ outcome: 'after' }])
    throw new Error('callback failed')
  } }), /callback failed/)
  assert.deepEqual(videoSnapshot(), before)
  assert.deepEqual(db.prepare('SELECT * FROM test_nfo_audit').all(), [])
  assert.deepEqual(deleted, ['new-cover'])
  await assert.rejects(delivery.deliverCandidate({ ...input, beforeCommit: async () => {} }), /must be synchronous/)
  assert.deepEqual(videoSnapshot(), before)
  await assert.rejects(delivery.deliverCandidate({ ...input, beforeCommit: async () => { throw new Error('async rejected') } }), /must be synchronous/)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(videoSnapshot(), before)
  assert.equal(deleted.includes('old-cover'), false)
})

it('keeps committed application when postcommit avatar lookup fails and returns the later warning', async () => {
  const db = getDb(), deleted: string[] = [], initialWarnings: string[][] = []
  const delivery = createVideoScrapeApplyService({
    coordinateDatabaseChange: ((operation: () => unknown) => operation()) as typeof mediaAssetStore.coordinateDatabaseChange,
    deleteBestEffort: (asset) => { if (asset) deleted.push(asset) },
    findActressByNameOrAlias: () => {
      assert.equal(db.inTransaction, false)
      throw new Error('avatar lookup unavailable')
    }
  })
  const result = await delivery.deliverCandidate({
    videoId, code: 'NFO-001', candidate: candidate('Committed title'),
    selectedFields: ['title'], fieldsToApply: ['title'], mode: 'fillEmpty',
    candidateStager: { stageForPending: async () => ({ candidates: [], warnings: [] }),
      deliverForApply: async () => ({ coverRel: null, sampleRels: [], avatarMap: new Map([['Actress', 'new-avatar']]) }) },
    beforeCommit: (outcome) => {
      assert.equal(db.inTransaction, true)
      assert.equal(outcome.applied, true)
      initialWarnings.push([...outcome.warnings])
    }
  })
  assert.equal(result.applied, true)
  assert.equal((videoSnapshot() as { title: string }).title, 'Committed title')
  assert.equal(initialWarnings.length, 1)
  assert.equal(initialWarnings[0].some((warning) => warning.includes('avatar lookup unavailable')), false)
  assert.ok(result.warnings.some((warning) => warning.includes('avatar lookup unavailable')))
  assert.deepEqual(deleted, ['new-avatar'])
})

it('keeps committed pending disposition when obsolete staging cleanup fails after the callback', async () => {
  const db = getDb(), initial: string[][] = []
  mediaAssetStore.cleanupVideoScrapeStagingPaths = () => {
    assert.equal(db.inTransaction, false)
    throw new Error('cleanup unavailable')
  }
  const result = await service(2).apply(videoId, 'NFO-001', [], (outcome) => {
    assert.equal(db.inTransaction, true)
    assert.equal(outcome.disposition, 'pending-candidate')
    initial.push([...outcome.warnings])
  })
  assert.equal(result.disposition, 'pending-candidate')
  assert.ok(db.prepare('SELECT 1 FROM pending_video_scrapes WHERE id=?').get(result.pendingScrapeId))
  assert.equal(initial.length, 1)
  assert.equal(initial[0].some((warning) => warning.includes('cleanup unavailable')), false)
  assert.ok(result.warnings.some((warning) => warning.includes('cleanup unavailable')))
})
