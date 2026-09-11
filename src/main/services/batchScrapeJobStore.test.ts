import { afterEach, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadBatchScrapeJob, saveBatchScrapeJob, saveBatchScrapeProgress, clearBatchScrapeJob,
  resetBatchScrapeJobCache, type PersistedBatchScrapeJob } from './batchScrapeJobStore'
import { SequentialBatchQueue } from './sequentialBatchQueue'

let root: string
let previous: string | undefined
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-checkpoint-test-'))
  previous = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = root
  resetBatchScrapeJobCache()
})
afterEach(() => {
  resetBatchScrapeJobCache()
  if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previous
  fs.rmSync(root, { recursive: true, force: true })
})
function job(total = 3): PersistedBatchScrapeJob {
  return { jobId: 'fixture', kind: 'video', request: { libraryId: 7, status: 'all', fields: ['title'] },
    targets: Array.from({ length: total }, (_, i) => ({ id: i + 1, label: `VIDEO-${i}` })),
    nextIndex: 0, success: 0, pending: 0, failed: 0, logs: [], total, status: 'running', updatedAt: '2026-01-01' }
}
const pointer = () => path.join(root, 'batch-scrape-job.json')

it('writes the definition once and keeps total checkpoint bytes near-linear', (t) => {
  const write = fs.writeFileSync
  let bytes = 0, definitions = 0
  t.mock.method(fs, 'writeFileSync', (...args: unknown[]) => {
    const body = String(args[1])
    bytes += Buffer.byteLength(body)
    if (body.includes('"targets"')) definitions++
    return Reflect.apply(write, fs, args)
  })
  const totals: number[] = []
  for (const count of [1000, 2000]) {
    clearBatchScrapeJob()
    bytes = 0; definitions = 0
    const value = job(count)
    for (let i = 0; i <= count; i++) saveBatchScrapeProgress({ ...value, nextIndex: i, success: i })
    totals.push(bytes)
    assert.equal(definitions, 1)
    const stored = JSON.parse(fs.readFileSync(pointer(), 'utf-8'))
    assert.equal(stored.targets, undefined)
    assert.equal(stored.request, undefined)
    assert.ok(fs.statSync(pointer()).size < 1024)
    resetBatchScrapeJobCache()
    assert.equal(loadBatchScrapeJob()?.nextIndex, count)
    assert.deepEqual(loadBatchScrapeJob()?.targets, value.targets)
  }
  assert.ok(totals[1] < totals[0] * 2.2, JSON.stringify(totals))
  t.diagnostic(JSON.stringify({ targets: [1000, 2000], totalWrittenBytes: totals, definitionWritesPerJob: 1 }))
})

it('reads legacy checkpoints and migrates on the next save without losing targets', () => {
  const value = job()
  fs.writeFileSync(pointer(), JSON.stringify(value))
  assert.deepEqual(loadBatchScrapeJob(), value)
  saveBatchScrapeProgress({ ...value, nextIndex: 1, success: 1 })
  assert.equal(JSON.parse(fs.readFileSync(pointer(), 'utf-8')).formatVersion, 2)
  resetBatchScrapeJobCache()
  assert.deepEqual(loadBatchScrapeJob()?.targets, value.targets)
  assert.equal(loadBatchScrapeJob()?.nextIndex, 1)
})

for (const failure of ['write', 'sync', 'rename'] as const) {
  it(`preserves the last checkpoint when ${failure} fails and retries safely`, (t) => {
    const value = job()
    saveBatchScrapeJob(value)
    const before = fs.readFileSync(pointer(), 'utf-8')
    const method = failure === 'write' ? 'writeFileSync' : failure === 'sync' ? 'fsyncSync' : 'renameSync'
    const mock = t.mock.method(fs, method, () => { throw Error(`injected ${failure}`) })
    assert.throws(() => saveBatchScrapeProgress({ ...value, nextIndex: 1, success: 1 }), /injected/)
    mock.mock.restore()
    resetBatchScrapeJobCache()
    assert.equal(fs.readFileSync(pointer(), 'utf-8'), before)
    assert.equal(loadBatchScrapeJob()?.nextIndex, 0)
    assert.ok(!fs.readdirSync(root).some(file => file.endsWith('.tmp')))
    saveBatchScrapeProgress({ ...value, nextIndex: 1, success: 1 })
    resetBatchScrapeJobCache()
    assert.equal(loadBatchScrapeJob()?.nextIndex, 1)
  })
}

it('keeps the old definition on failed replacement and prunes unused manifests after commit', (t) => {
  const value = job()
  saveBatchScrapeJob(value)
  const rename = fs.renameSync
  const mock = t.mock.method(fs, 'renameSync', (...args: unknown[]) => {
    if (args[1] === pointer()) throw Error('pointer commit failed')
    return Reflect.apply(rename, fs, args)
  })
  const replacement = { ...value, targets: [{ id: 9, label: 'new' }], total: 1 }
  assert.throws(() => saveBatchScrapeJob(replacement), /commit failed/)
  mock.mock.restore()
  resetBatchScrapeJobCache()
  assert.deepEqual(loadBatchScrapeJob()?.targets, value.targets)
  saveBatchScrapeJob(replacement)
  assert.equal(fs.readdirSync(root).filter(file => file.startsWith('batch-scrape-targets-')).length, 1)
  clearBatchScrapeJob()
  assert.deepEqual(fs.readdirSync(root), [])
})

it('refuses missing, tampered or mismatched manifests instead of treating the job as absent', () => {
  saveBatchScrapeJob(job())
  const record = JSON.parse(fs.readFileSync(pointer(), 'utf-8'))
  const file = path.join(root, record.manifestFile)
  fs.appendFileSync(file, ' ')
  resetBatchScrapeJobCache()
  assert.throws(loadBatchScrapeJob, /无法读取/)
  assert.ok(fs.existsSync(pointer()))
  fs.unlinkSync(file)
  assert.throws(loadBatchScrapeJob, /无法读取/)
})

it('stops the queue on checkpoint failure and resumes from the durable cursor without skipping work', async (t) => {
  const value = job(2)
  saveBatchScrapeJob(value)
  const queue = new SequentialBatchQueue<{ id: number; label: string }>()
  const completed: number[] = []
  const run = {
    targets: value.targets, startMessage: () => 'start', pausedMessage: 'paused', cancelledMessage: 'cancelled',
    doneMessage: () => 'done', getCode: (target: { label: string }) => target.label,
    runTarget: async (target: { id: number }) => {
      completed.push(target.id)
      return { status: 'success' as const, level: 'info' as const, message: 'ok' }
    }, exceptionMessage: () => 'target failed', delayAfterTarget: false,
    onCheckpoint: (_progress: unknown, nextIndex: number) => saveBatchScrapeProgress({ ...value, nextIndex, success: nextIndex })
  }
  const write = t.mock.method(fs, 'writeFileSync', () => { throw Error('disk full') })
  await assert.rejects(queue.start(run), /disk full/)
  write.mock.restore()
  assert.deepEqual(completed, [1])
  assert.equal(queue.getProgress().status, 'paused')
  resetBatchScrapeJobCache()
  const durable = loadBatchScrapeJob()!
  assert.equal(durable.nextIndex, 0)
  await queue.start({ ...run, startIndex: durable.nextIndex })
  assert.deepEqual(completed, [1, 1, 2], 'an uncheckpointed target is retried, never silently skipped')
})

it('rejects damaged cursor and total fields without deleting the checkpoint', () => {
  saveBatchScrapeJob(job())
  const original = JSON.parse(fs.readFileSync(pointer(), 'utf-8'))
  for (const change of [{ nextIndex: 30 }, { nextIndex: -1 }, { nextIndex: 1.5 }, { total: 1 }]) {
    const raw = JSON.stringify({ ...original, ...change })
    fs.writeFileSync(pointer(), raw)
    resetBatchScrapeJobCache()
    assert.throws(loadBatchScrapeJob, /无法读取/)
    assert.equal(fs.readFileSync(pointer(), 'utf-8'), raw)
    assert.ok(fs.existsSync(path.join(root, original.manifestFile)))
  }
})

for (const operation of ['replace', 'clear'] as const) {
  it(`reloads actual disk state and retains the manifest after ${operation} directory-sync failure`, { skip: process.platform === 'win32' }, (t) => {
    const value = job()
    saveBatchScrapeJob(value)
    const record = JSON.parse(fs.readFileSync(pointer(), 'utf-8'))
    const sync = fs.fsyncSync
    const fault = t.mock.method(fs, 'fsyncSync', (fd: number) => {
      if (fs.fstatSync(fd).isDirectory()) throw Error('directory sync failed')
      return sync(fd)
    })
    assert.throws(() => operation === 'clear' ? clearBatchScrapeJob()
      : saveBatchScrapeProgress({ ...value, nextIndex: 1, success: 1 }), /directory sync/)
    fault.mock.restore()
    assert.ok(fs.existsSync(path.join(root, record.manifestFile)))
    // Do not reset the cache here: the failed mutation itself must invalidate it.
    if (operation === 'clear') assert.equal(loadBatchScrapeJob(), null)
    else assert.equal(loadBatchScrapeJob()?.nextIndex, 1)
  })
}

it('does not report committed saves or clears as failed when manifest cleanup cannot enumerate', (t) => {
  t.mock.method(console, 'error', () => {})
  const read = t.mock.method(fs, 'readdirSync', () => { throw Error('cleanup unavailable') })
  assert.doesNotThrow(() => saveBatchScrapeJob(job()))
  resetBatchScrapeJobCache()
  assert.equal(loadBatchScrapeJob()?.jobId, 'fixture')
  assert.doesNotThrow(clearBatchScrapeJob)
  assert.equal(loadBatchScrapeJob(), null)
  read.mock.restore()
})
