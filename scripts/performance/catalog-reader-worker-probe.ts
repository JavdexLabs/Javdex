/** Native SQLite worker viability probe; synthetic catalog, no production IPC wiring. */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { buildSync } from 'esbuild'
import { closeDatabase, initDatabaseAtPath } from '../../src/main/db/database'

it('runs native catalog reads in a worker while main timers continue', async () => {
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-reader-worker-'))
const catalog = path.join(root, 'catalog.db')
const entry = path.join(root, 'reader.ts')
const bundle = path.join(root, 'reader.cjs')
const workload = 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000) SELECT SUM(x) AS total FROM n'
let worker: Worker | undefined
let timer: ReturnType<typeof setInterval> | undefined
try {
  const db = initDatabaseAtPath(catalog)
  db.exec("INSERT INTO tags(id,name) VALUES(1,'École')")
  fs.writeFileSync(entry, `
    import { parentPort, workerData } from 'node:worker_threads';
    import { openReadOnlyDatabaseAtPath } from ${JSON.stringify(path.resolve('src/main/db/database.ts'))};
    const reader = openReadOnlyDatabaseAtPath(workerData.catalog);
    let reply;
    try {
      const label = reader.prepare("SELECT tag_name_contains_folded(name,'éco') AS matched FROM tags").get();
      parentPort.postMessage({phase:'reading'});
      const started = performance.now();
      const result = reader.prepare(workerData.workload).get();
      reply = {phase:'done',result,label,elapsedMs:performance.now()-started,readonly:reader.readonly};
    } finally { reader.close(); }
    parentPort.postMessage(reply);
  `)
  buildSync({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
    packages: 'external', tsconfig: path.resolve('tsconfig.node.json'),
    banner: { js: `require = require('node:module').createRequire(${JSON.stringify(path.resolve('package.json'))});` } })
  let ticks = 0
  let startedTicks = 0
  let lastTick = performance.now()
  let maxGap = 0
  timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now-lastTick); lastTick=now; ticks++ }, 5)
  const reply = await new Promise<{ result: { total: number }; label: { matched: number }; elapsedMs: number; readonly: boolean; ticksDuringRead: number }>((resolve,reject) => {
    let completed = false
    worker = new Worker(bundle, { workerData: { catalog, workload }, execArgv: [] })
    const watchdog = setTimeout(() => reject(new Error('reader probe timed out')), 15000)
    worker.once('error', error => { clearTimeout(watchdog); reject(error) })
    worker.once('exit', code => { clearTimeout(watchdog); if (!completed) reject(new Error(`reader exited ${code} without a result`)) })
    worker.on('message', message => {
      if (message.phase === 'reading') startedTicks = ticks
      if (message.phase === 'done') { completed = true; clearTimeout(watchdog); resolve({ ...message, ticksDuringRead: ticks-startedTicks }) }
    })
  })
  await worker.terminate(); worker = undefined
  assert.equal(reply.result.total, 500000500000)
  assert.equal(reply.label.matched, 1)
  assert.equal(reply.readonly, true)
  assert.ok(reply.ticksDuringRead > 0, 'main timers must run while the worker read request is in progress')
  const workerMaxTimerGapMs = maxGap
  maxGap = 0; lastTick = performance.now()
  const before = ticks
  const started = performance.now()
  const direct = db.prepare(workload).get()
  const directMs = performance.now()-started
  assert.deepEqual(direct, reply.result)
  assert.equal(ticks, before, 'synchronous main query does not yield to timers')
  await new Promise(resolve => setTimeout(resolve, 10))
  const output = { runtime: process.versions, platform: process.platform, arch: process.arch,
    worker: reply, workerMaxTimerGapMs, directMs, directMaxTimerGapMs: maxGap,
    caveats: ['Single synthetic CPU query; not real large-library latency, p95, Windows/HDD or production IPC validation.',
      'Worker uses actual read-only factory and native SQLite; bundle creation and fixture setup are outside timer measurement.',
      'ticksDuringRead spans main receipt of reading/done messages, including message scheduling and reader.close tail; not every tick is proven inside native SELECT.',
      'workerMaxTimerGapMs includes worker startup/loading/read/termination wait; elapsedMs and directMs measure SQL prepare/get.',
      'No production worker pool, admission queue, cancellation, packaging path or shutdown integration is claimed.'] }
  if (process.env.JAVDEX_READER_PROBE_OUTPUT) fs.writeFileSync(path.resolve(process.env.JAVDEX_READER_PROBE_OUTPUT), JSON.stringify(output,null,2)+'\n')
  console.log(JSON.stringify(output))
} finally {
  if (timer) clearInterval(timer)
  await worker?.terminate()
  closeDatabase()
  fs.rmSync(root, { recursive: true, force: true })
}

})
