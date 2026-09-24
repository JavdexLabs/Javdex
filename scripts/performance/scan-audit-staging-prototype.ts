/** UNSHIPPED persistence model probe. Scratch DB only; not a production migration.
 * Run: node scripts/run-electron-tests.mjs scripts/performance/scan-audit-staging-prototype.ts
 * Question: can bounded mutable batches become immutable, atomically published audit history?
 */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { performance } from 'node:perf_hooks'
import { initDatabaseAtPath, closeDatabase } from '../../packages/library/src/db/database'
import { createMediaLibrary } from '../../packages/library/src/db/mediaLibraryRepo'
import { beginLibraryScanRun, recoverInterruptedLibraryScanRuns } from '../../packages/library/src/db/libraryScanRepo'
import { readScanAuditHeader } from '../../apps/desktop/src/main/services/scanAuditReadHeader'
import { createPrototypeAuditStore, type PrototypeAuditRow } from './prototypes/scan-audit-staging.prototype'

it('drives scratch staging, revision, failed publication, visible publication and restart recovery', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'Javdex-PROTOTYPE-audit-'))
  const filename = path.join(directory, 'PROTOTYPE-wipe-me.sqlite')
  let reader: Database.Database | undefined
  try {
    let db = initDatabaseAtPath(filename)
    const library = createMediaLibrary({ name: 'Prototype', roots: [{ path: directory }] })
    const libraryId = library.id
    let store = createPrototypeAuditStore(db)
    const begin = (runId: string) => beginLibraryScanRun({ libraryId, runId, configRevision: 1, trigger: 'manual', startedAt: 'start' })
    const meta = (runId: string) => ({ schemaVersion: 2, libraryId, runId, finishedAt: 'finish' })
    const summary = (runId: string) => ({ libraryId, runId, status: 'success', finishedAt: 'finish' })
    const commit = (runId: string) => {
      db.prepare("UPDATE library_scan_runs SET status='completed',finished_at='finish',summary_json=? WHERE id=?")
        .run(JSON.stringify(summary(runId)), runId)
      db.prepare("UPDATE media_library_scan_state SET active_run_id=NULL,last_status='completed',last_finished_at='finish',last_summary_json=?,revision=revision+1 WHERE library_id=?")
        .run(JSON.stringify(summary(runId)), libraryId)
      db.prepare('DELETE FROM library_unrecognized_files WHERE library_id=?').run(libraryId)
      db.prepare('INSERT INTO library_unrecognized_files(library_id,root_id,file_path,normalized_path,scan_run_id,last_seen_at) VALUES(?,?,?,?,?,?)')
        .run(libraryId, library.roots[0].id, '/unknown', '/unknown', runId, 'finish')
    }
    const snapshot = () => ({
      state: db.prepare('SELECT * FROM media_library_scan_state WHERE library_id=?').get(libraryId),
      runs: db.prepare('SELECT * FROM library_scan_runs WHERE library_id=? ORDER BY id').all(libraryId),
      unknown: db.prepare('SELECT * FROM library_unrecognized_files WHERE library_id=?').all(libraryId)
    })
    const print = (action: string, run: string) => console.log(JSON.stringify({ action, run, state: store.inspect(libraryId, run) }))
    begin('old'); store.start(libraryId, 'old', meta('old'))
    store.writeBatch(libraryId, 'old', [{ section: 'files', key: '/old', entry: { filePath: '/old', outcome: 'unrecognized' } }])
    store.seal(libraryId, 'old'); store.publish(libraryId, 'old', () => commit('old')); print('publish-old', 'old')
    begin('new'); store.start(libraryId, 'new', meta('new'))
    const rows: PrototypeAuditRow[] = Array.from({ length: 3 }, (_, i) => ({ section: 'files', key: `/file-${i}`, entry: { filePath: `/file-${i}`, outcome: 'added', value: i } }))
    store.writeBatch(libraryId, 'new', rows)
    store.writeBatch(libraryId, 'new', [{ ...rows[1], entry: { ...rows[1].entry, value: 99 } }])
    store.patchNfo(libraryId, 'new', '/file-1', { disposition: 'imported' })
    assert.equal(store.patchNfo(libraryId, 'new', '/missing', {}), false)
    assert.throws(() => store.readPage(libraryId, 'new', 'files', 0, 100), /published|terminal/)
    assert.throws(() => store.writeBatch(libraryId + 100, 'new', []), /belong/)
    const beforeInvalid = store.inspect(libraryId, 'new')
    assert.throws(() => store.writeBatch(libraryId, 'new', Array.from({ length: 101 }, () => rows[0])), /100 rows/)
    assert.throws(() => store.writeBatch(libraryId, 'new', [{ section: 'files', key: '/large', entry: { text: '字'.repeat(400000) } }]), /1 MiB/)
    assert.deepEqual(store.inspect(libraryId, 'new'), beforeInvalid)
    db.exec("CREATE TEMP TRIGGER fail_prototype_batch BEFORE INSERT ON prototype_audit_entries WHEN NEW.entry_key='/boom' BEGIN SELECT RAISE(ABORT,'injected batch failure'); END")
    assert.throws(() => store.writeBatch(libraryId, 'new', [
      { section: 'files', key: '/would-insert', entry: {} }, { section: 'files', key: '/boom', entry: {} }
    ]), /injected batch failure/)
    assert.deepEqual(store.inspect(libraryId, 'new'), beforeInvalid)
    db.exec('DROP TRIGGER fail_prototype_batch')
    print('mutate-and-reject-bad-batches', 'new')
    store.seal(libraryId, 'new')
    assert.throws(() => store.patchNfo(libraryId, 'new', '/file-1', {}), /collecting/)
    assert.throws(() => store.readPage(libraryId, 'new', 'files', 0, 100), /published|terminal/)
    const beforePublish = snapshot()
    assert.throws(() => store.publish(libraryId, 'new', () => {}), /terminal/)
    assert.throws(() => store.publish(libraryId, 'new', () => Promise.resolve()), /synchronous/)
    assert.deepEqual(snapshot(), beforePublish)
    assert.throws(() => store.publish(libraryId, 'new', () => { commit('new'); throw Error('injected publish failure') }), /injected publish/)
    assert.deepEqual(snapshot(), beforePublish)
    assert.equal(store.inspect(libraryId, 'new')!.state, 'sealed')
    assert.equal(store.readPage(libraryId, 'old', 'files', 0, 100)[0].key, '/old')
    print('publication-rollback', 'new')
    reader = new Database(filename, { readonly: true, timeout: 0 })
    store.publish(libraryId, 'new', () => {
      commit('new')
      assert.equal((reader!.prepare('SELECT state FROM prototype_audit_manifest WHERE run_id=?').get('new') as { state: string }).state, 'sealed')
      assert.equal((reader!.prepare('SELECT scan_run_id FROM library_unrecognized_files WHERE library_id=?').get(libraryId) as { scan_run_id: string }).scan_run_id, 'old')
    })
    assert.equal((reader.prepare('SELECT state FROM prototype_audit_manifest WHERE run_id=?').get('new') as { state: string }).state, 'published')
    assert.equal((reader.prepare('SELECT scan_run_id FROM library_unrecognized_files WHERE library_id=?').get(libraryId) as { scan_run_id: string }).scan_run_id, 'new')
    const visible = store.readPage(libraryId, 'new', 'files', 0, 100)
    assert.deepEqual(visible.map(row => row.ordinal), [0, 1, 2])
    assert.equal(visible[1].entry.value, 99)
    assert.deepEqual(visible[1].entry.nfo, { disposition: 'imported' })
    assert.throws(() => store.writeBatch(libraryId, 'new', rows), /running|collecting/)
    assert.throws(() => store.publish(libraryId, 'new', () => commit('new')), /running|sealed/)
    assert.equal(readScanAuditHeader(db, libraryId).snapshot, null, 'legacy reader does not yet understand prototype storage; production adapter is still required')
    print('atomic-publication', 'new')
    reader.close(); reader = undefined
    begin('interrupted'); store.start(libraryId, 'interrupted', meta('interrupted')); store.writeBatch(libraryId, 'interrupted', rows)
    store.seal(libraryId, 'interrupted'); closeDatabase()
    db = initDatabaseAtPath(filename); store = createPrototypeAuditStore(db)
    const recovered = recoverInterruptedLibraryScanRuns(db, 'recovered')
    assert.equal(recovered.recoveredRunCount, 1)
    assert.equal(store.recover(libraryId, 'interrupted'), true)
    assert.equal(store.recover(libraryId, 'interrupted'), false)
    assert.equal(store.inspect(libraryId, 'interrupted')!.count, 3)
    assert.throws(() => store.readPage(libraryId, 'interrupted', 'files', 0, 100), /published|terminal/)
    assert.equal(store.recover(libraryId, 'new'), false)
    assert.deepEqual(store.readPage(libraryId, 'new', 'files', 0, 100), visible)
    assert.deepEqual(db.pragma('foreign_key_check'), [])
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
    print('restart-abandons-staging-without-deleting-history', 'interrupted')
  } finally { reader?.close(); closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }) }
})

it('streams a scratch 100k-file run using bounded input batches and reads a deep page', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'Javdex-PROTOTYPE-audit-scale-'))
  try {
    const filename = path.join(directory, 'PROTOTYPE-wipe-me.sqlite')
    const db = initDatabaseAtPath(filename)
    const library = createMediaLibrary({ name: 'Scale prototype', roots: [{ path: directory }] })
    const store = createPrototypeAuditStore(db), count = 100000, runId = 'scale'
    beginLibraryScanRun({ libraryId: library.id, runId, configRevision: 1, trigger: 'manual', startedAt: 'start' })
    store.start(library.id, runId, { schemaVersion: 2, libraryId: library.id, runId, finishedAt: 'finish' })
    let maxRows = 0, maxBytes = 0
    const started = performance.now()
    for (let offset = 0; offset < count; offset += 100) {
      const batch: PrototypeAuditRow[] = Array.from({ length: Math.min(100, count - offset) }, (_, i) => ({
        section: 'files', key: `/file-${offset + i}`, entry: { filePath: `/file-${offset + i}`, outcome: 'added', value: offset + i, text: 'x'.repeat(128) }
      }))
      maxRows = Math.max(maxRows, batch.length); maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(batch)))
      store.writeBatch(library.id, runId, batch)
    }
    const writeMs = performance.now() - started
    assert.equal(store.inspect(library.id, runId)!.count, count)
    store.patchNfo(library.id, runId, '/file-99999', { disposition: 'imported' })
    store.seal(library.id, runId)
    const publishStart = performance.now()
    store.publish(library.id, runId, () => db.prepare("UPDATE library_scan_runs SET status='completed',finished_at='finish' WHERE id=?").run(runId))
    const publishMs = performance.now() - publishStart
    const pageStart = performance.now()
    const page = store.readPage(library.id, runId, 'files', 99900, 100)
    const pageMs = performance.now() - pageStart
    assert.deepEqual(page.map(row => row.entry.value), Array.from({ length: 100 }, (_, i) => 99900 + i))
    assert.deepEqual(page[99].entry.nfo, { disposition: 'imported' })
    assert.equal(maxRows, 100); assert.ok(maxBytes < 1024 * 1024)
    console.log(JSON.stringify({ action: '100k-prototype', count, maxRows, maxBytes, writeMs, publishMs, pageMs,
      databaseBytes: fs.statSync(filename).size, walBytes: fs.existsSync(filename + '-wal') ? fs.statSync(filename + '-wal').size : 0,
      notes: ['single run, no warm/p95 or peak-memory claim', 'publish timing only prototype run marker, excludes actual finish state/unrecognized work',
        'source generated one batch at a time; native SQLite and individual serialization allocations not a total RSS bound',
        'OFFSET deep page still walks earlier ordinal index entries; production reader/index integration not implemented'] }))
  } finally { closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }) }
})

it('rejects unreadable patched rows and oversized key pages before hydration', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'Javdex-PROTOTYPE-audit-budget-'))
  try {
    const db = initDatabaseAtPath(path.join(directory, 'PROTOTYPE-wipe-me.sqlite'))
    const library = createMediaLibrary({ name: 'Budget prototype', roots: [{ path: directory }] })
    const store = createPrototypeAuditStore(db), limit = 1024 * 1024
    const begin = (runId: string) => {
      beginLibraryScanRun({ libraryId: library.id, runId, configRevision: 1, trigger: 'manual', startedAt: 'start' })
      store.start(library.id, runId, {})
    }
    const publish = (runId: string) => {
      store.seal(library.id, runId)
      store.publish(library.id, runId, () => { db.prepare("UPDATE library_scan_runs SET status='completed' WHERE id=?").run(runId) })
    }
    begin('patch')
    const entry = { filePath: '/patch' }
    store.writeBatch(library.id, 'patch', [{ section: 'files', key: '/patch', entry }])
    const padding = limit - Buffer.byteLength(JSON.stringify({ ...entry, nfo: { padding: '' } }))
    const before = store.inspect(library.id, 'patch')
    assert.throws(() => store.patchNfo(library.id, 'patch', '/patch', { padding: 'x'.repeat(padding) }), /1 MiB/,
      'a body at the limit cannot fit its full single-item page and must be rejected before publication')
    assert.deepEqual(store.inspect(library.id, 'patch'), before)
    store.patchNfo(library.id, 'patch', '/patch', { padding: 'x'.repeat(padding - 128) })
    publish('patch')
    const page = store.readPage(library.id, 'patch', 'files', 0, 1)
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= limit)
    assert.equal((page[0].entry.nfo as { padding: string }).padding.length, padding - 128)

    begin('keys')
    for (let i = 0; i < 2; i++) store.writeBatch(library.id, 'keys', [
      { section: 'files', key: 'k'.repeat(600000) + i, entry: {} }
    ])
    publish('keys')
    assert.equal(store.readPage(library.id, 'keys', 'files', 0, 1).length, 1)
    const originalPrepare = db.prepare, prepare = db.prepare.bind(db)
    const projected: string[] = []
    db.prepare = ((sql: string) => {
      projected.push(sql)
      if (/SELECT ordinal, entry_key AS key, body, bytes/.test(sql)) throw Error('unexpected payload hydration')
      return prepare(sql)
    }) as typeof db.prepare
    try {
      assert.throws(() => store.readPage(library.id, 'keys', 'files', 0, 2), /Audit page/)
      assert.ok(projected.every(sql => !/entry_key AS key/.test(sql)), 'preflight must project lengths, not huge keys')
    } finally { db.prepare = originalPrepare }
    console.log(JSON.stringify({ action: 'budget-boundaries', nearLimitSinglePageBytes: Buffer.byteLength(JSON.stringify(page)), oversizedKeyPageRejectedBeforeHydration: true }))
  } finally { closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }) }
})

it('recovers committed staging and rolls back uncommitted publication after SIGKILL', async () => {
  const { spawn } = await import('node:child_process')
  for (const phase of ['staged', 'uncommitted-publication']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'Javdex-PROTOTYPE-audit-kill-'))
    const filename = path.join(directory, 'PROTOTYPE-wipe-me.sqlite')
    try {
      let db = initDatabaseAtPath(filename)
      const library = createMediaLibrary({ name: 'Crash prototype', roots: [{ path: directory }] })
      let store = createPrototypeAuditStore(db)
      beginLibraryScanRun({ libraryId: library.id, runId: 'old', configRevision: 1, trigger: 'manual', startedAt: 'old' })
      store.start(library.id, 'old', {}); store.writeBatch(library.id, 'old', [{ section: 'files', key: '/old', entry: { old: true } }])
      store.seal(library.id, 'old')
      store.publish(library.id, 'old', () => { db.prepare("UPDATE library_scan_runs SET status='completed' WHERE id='old'").run() })
      const old = store.readPage(library.id, 'old', 'files', 0, 100)
      beginLibraryScanRun({ libraryId: library.id, runId: 'crash', configRevision: 1, trigger: 'manual', startedAt: 'new' })
      const stateBefore = db.prepare('SELECT * FROM media_library_scan_state WHERE library_id=?').get(library.id)
      closeDatabase()
      const child = spawn(process.execPath, ['--require', './scripts/register-test-paths.cjs', '--import', 'tsx',
        'scripts/performance/prototypes/scan-audit-staging-crash-child.prototype.ts', filename, String(library.id), 'crash', phase],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      let stderr = ''
      child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2048) })
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject)
      })
      try {
        const readiness = await new Promise<{ inTransaction: boolean }>((resolve, reject) => {
          const timeout = setTimeout(() => reject(Error('Crash child readiness timeout: ' + stderr)), 10000)
          child.once('message', message => { clearTimeout(timeout); resolve(message as { inTransaction: boolean }) })
          child.once('error', error => { clearTimeout(timeout); reject(error) })
          child.once('exit', () => { clearTimeout(timeout); reject(Error('Crash child exited before ready: ' + stderr)) })
        })
        assert.equal(readiness.inTransaction, phase === 'uncommitted-publication')
        assert.equal(child.kill('SIGKILL'), true)
        assert.equal((await exited).signal, 'SIGKILL')
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await exited
      }
      db = initDatabaseAtPath(filename); store = createPrototypeAuditStore(db)
      assert.equal(store.inspect(library.id, 'crash')!.state, 'sealed')
      assert.equal(store.inspect(library.id, 'crash')!.count, 3)
      assert.equal((db.prepare("SELECT status FROM library_scan_runs WHERE id='crash'").get() as { status: string }).status, 'running')
      assert.deepEqual(db.prepare('SELECT * FROM media_library_scan_state WHERE library_id=?').get(library.id), stateBefore)
      assert.throws(() => store.readPage(library.id, 'crash', 'files', 0, 100), /published|terminal/)
      assert.equal(recoverInterruptedLibraryScanRuns(db).recoveredRunCount, 1)
      assert.equal(store.recover(library.id, 'crash'), true)
      assert.deepEqual(store.readPage(library.id, 'old', 'files', 0, 100), old)
      assert.deepEqual(db.pragma('foreign_key_check'), [])
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
      console.log(JSON.stringify({ action: 'SIGKILL-recovery', phase, stagedRowsPreserved: 3, previousPublishedPreserved: true }))
    } finally { closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }) }
  }
})
