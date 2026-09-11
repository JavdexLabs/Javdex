import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LibraryScanAudit, LibraryScanSummary } from '@shared/libraryTypes'
import { normalizeLocalPathIdentity } from '@shared/localPathIdentity'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { archiveMediaLibrary, createMediaLibrary } from './mediaLibraryRepo'
import { createMediaLibraryRootMigrationRepo } from './mediaLibraryRootMigrationRepo'
import {
  beginLibraryScanRun,
  finishLibraryScanRun,
  getLatestLibraryScanSnapshot,
  INTERRUPTED_LIBRARY_SCAN_ERROR,
  recoverInterruptedLibraryScanRuns,
  renameLibraryUnrecognizedFile
} from './libraryScanRepo'

let tempRoot = ''

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-library-scan-repo-'))
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
})

afterEach(() => {
  closeDatabase()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

function beginSuccessfulRun(input: {
  libraryId: number
  rootId: number
  runId: string
  filePath: string
}): Parameters<typeof finishLibraryScanRun>[0] {
  const startedAt = '2026-08-29T01:00:00.000Z'
  const finishedAt = '2026-08-29T01:00:01.000Z'
  const summary: LibraryScanSummary = {
    libraryId: input.libraryId,
    runId: input.runId,
    configRevision: 1,
    trigger: 'manual',
    startedAt,
    finishedAt,
    status: 'success',
    scannedFiles: 1,
    resourcesAdded: 0,
    resourcesUpdated: 0,
    resourcesRemoved: 0,
    primaryResourcesPromoted: 0,
    videosDeleted: 0,
    skippedFiles: 0,
    failedFiles: 1,
    pendingScanGroups: 0,
    pendingScanResources: 0,
    offlineFolders: [],
    errorSummary: null
  }
  const audit: LibraryScanAudit = {
    schemaVersion: 1,
    libraryId: input.libraryId,
    runId: input.runId,
    configRevision: 1,
    trigger: 'manual',
    startedAt,
    finishedAt,
    status: 'success',
    files: [
      {
        rootId: input.rootId,
        filePath: input.filePath,
        sourceKind: 'local',
        outcome: 'unrecognized'
      }
    ],
    removedResources: [],
    promotedResources: [],
    deletedVideos: [],
    pendingGroups: []
  }
  beginLibraryScanRun({
    libraryId: input.libraryId,
    runId: input.runId,
    configRevision: 1,
    trigger: 'manual',
    startedAt
  })
  return {
    libraryId: input.libraryId,
    runId: input.runId,
    status: 'completed',
    summary,
    audit,
    replaceUnrecognizedRootIds: [input.rootId],
    unrecognizedFiles: [
      {
        rootId: input.rootId,
        filePath: input.filePath,
        normalizedPath: normalizeLocalPathIdentity(input.filePath),
        reason: 'unrecognized_code'
      }
    ]
  }
}

function persistSuccessfulRun(input: Parameters<typeof beginSuccessfulRun>[0]): void {
  finishLibraryScanRun(beginSuccessfulRun(input))
}

describe('libraryScanRepo latest snapshot', () => {
  it('keeps a valid summary pinned to its run when its audit is NULL', () => {
    const directory = path.join(tempRoot, 'pinned-audit')
    fs.mkdirSync(directory)
    const library = createMediaLibrary({ name: 'Pinned', roots: [{ path: directory }] })
    for (const runId of ['older-audit', 'summary-run']) {
      persistSuccessfulRun({ libraryId: library.id, rootId: library.roots[0].id, runId,
        filePath: path.join(directory, `${runId}.mp4`) })
    }
    getDb().prepare('UPDATE library_scan_runs SET audit_json = NULL WHERE id = ?').run('summary-run')
    const snapshot = getLatestLibraryScanSnapshot(library.id)
    assert.equal(snapshot.summary?.runId, 'summary-run')
    assert.equal(snapshot.audit, null)
  })

  it('falls back for malformed summary by timestamp then id, excluding NULL bodies without a status filter', () => {
    const directory = path.join(tempRoot, 'fallback-audit')
    fs.mkdirSync(directory)
    const library = createMediaLibrary({ name: 'Fallback', roots: [{ path: directory }] })
    for (const runId of ['z-older', 'a-newer', 'b-newer', 'c-null']) {
      persistSuccessfulRun({ libraryId: library.id, rootId: library.roots[0].id, runId,
        filePath: path.join(directory, `${runId}.mp4`) })
    }
    const db = getDb()
    db.prepare('UPDATE media_library_scan_state SET last_summary_json = ? WHERE library_id = ?')
      .run('{malformed', library.id)
    db.prepare('UPDATE library_scan_runs SET started_at = ? WHERE id <> ? AND library_id = ?')
      .run('2026-09-01T00:00:00.000Z', 'z-older', library.id)
    db.prepare("UPDATE library_scan_runs SET status = 'running' WHERE id = ?").run('b-newer')
    db.prepare('UPDATE library_scan_runs SET audit_json = NULL WHERE id = ?').run('c-null')
    const snapshot = getLatestLibraryScanSnapshot(library.id)
    assert.equal(snapshot.summary, null)
    assert.equal(snapshot.audit?.runId, 'b-newer')

    db.prepare('UPDATE library_scan_runs SET audit_json = ? WHERE id = ?').run('{malformed', 'b-newer')
    assert.equal(getLatestLibraryScanSnapshot(library.id).audit, null)
  })

  it('updates the pending path after a rename without rewriting the original scan audit', () => {
    const directory = path.join(tempRoot, 'library')
    fs.mkdirSync(directory)
    const library = createMediaLibrary({ name: 'A', roots: [{ path: directory }] })
    const rootId = library.roots[0].id
    const oldPath = path.join(directory, 'unknown.mp4')
    const newPath = path.join(directory, 'still-unknown.mp4')
    persistSuccessfulRun({ libraryId: library.id, rootId, runId: 'rename-test', filePath: oldPath })
    renameLibraryUnrecognizedFile(library.id, rootId, normalizeLocalPathIdentity(oldPath), {
      filePath: newPath, normalizedPath: normalizeLocalPathIdentity(newPath)
    })
    const latest = getLatestLibraryScanSnapshot(library.id)
    assert.deepEqual(latest.unrecognized, [{ rootId, filePath: newPath }])
    assert.equal(latest.audit?.files[0].filePath, oldPath)
  })

  it('returns summary, audit, and unrecognized files only from the requested library', () => {
    const rootA = path.join(tempRoot, 'library-a')
    const rootB = path.join(tempRoot, 'library-b')
    fs.mkdirSync(rootA)
    fs.mkdirSync(rootB)
    const libraryA = createMediaLibrary({ name: 'A', roots: [{ path: rootA }] })
    const libraryB = createMediaLibrary({ name: 'B', roots: [{ path: rootB }] })
    const fileA = path.join(rootA, 'UNKNOWN-A.mp4')
    const fileB = path.join(rootB, 'UNKNOWN-B.mp4')

    persistSuccessfulRun({
      libraryId: libraryA.id,
      rootId: libraryA.roots[0].id,
      runId: 'scan-a',
      filePath: fileA
    })
    persistSuccessfulRun({
      libraryId: libraryB.id,
      rootId: libraryB.roots[0].id,
      runId: 'scan-b',
      filePath: fileB
    })

    const latestA = getLatestLibraryScanSnapshot(libraryA.id)
    const latestB = getLatestLibraryScanSnapshot(libraryB.id)
    assert.equal(latestA.summary?.runId, 'scan-a')
    assert.equal(latestA.audit?.runId, 'scan-a')
    assert.deepEqual(latestA.unrecognized, [
      { rootId: libraryA.roots[0].id, filePath: fileA }
    ])
    assert.equal(latestB.summary?.runId, 'scan-b')
    assert.equal(latestB.audit?.runId, 'scan-b')
    assert.deepEqual(latestB.unrecognized, [
      { rootId: libraryB.roots[0].id, filePath: fileB }
    ])
  })

  it('transactionally settles scan runs abandoned by the previous process', () => {
    const firstRoot = path.join(tempRoot, 'interrupted-a')
    const secondRoot = path.join(tempRoot, 'interrupted-b')
    fs.mkdirSync(firstRoot)
    fs.mkdirSync(secondRoot)
    const first = createMediaLibrary({ name: 'Interrupted A', roots: [{ path: firstRoot }] })
    const second = createMediaLibrary({ name: 'Interrupted B', roots: [{ path: secondRoot }] })
    const databasePath = path.join(tempRoot, 'library.db')
    getDb()
      .prepare(
        `INSERT INTO library_scan_runs (
           id, library_id, config_revision, trigger, status, started_at
         ) VALUES (?, ?, 1, 'manual', ?, ?)`
      )
      .run('previous-running', first.id, 'running', '2026-08-28T23:00:00.000Z')
    getDb()
      .prepare(
        `INSERT INTO library_scan_runs (
           id, library_id, config_revision, trigger, status, started_at
         ) VALUES (?, ?, 1, 'automatic', ?, ?)`
      )
      .run('previous-queued', second.id, 'queued', '2026-08-28T23:05:00.000Z')
    getDb()
      .prepare(
        'INSERT OR IGNORE INTO media_library_scan_state (library_id) VALUES (?), (?)'
      )
      .run(first.id, second.id)
    getDb()
      .prepare(
        `UPDATE media_library_scan_state
            SET active_run_id = ?, last_status = 'running',
                last_started_at = ?, last_summary_json = '{"stale":true}'
          WHERE library_id = ?`
      )
      .run('previous-running', '2026-08-28T23:00:00.000Z', first.id)
    getDb()
      .prepare(
        `UPDATE media_library_scan_state
            SET active_run_id = ?, last_status = 'queued', last_started_at = ?
          WHERE library_id = ?`
      )
      .run('previous-queued', '2026-08-28T23:05:00.000Z', second.id)

    closeDatabase()
    const restarted = initDatabaseAtPath(databasePath)
    const recoveredAt = '2026-08-29T00:00:00.000Z'
    assert.deepEqual(recoverInterruptedLibraryScanRuns(restarted, recoveredAt), {
      recoveredRunCount: 2,
      recoveredStateCount: 2
    })
    assert.deepEqual(
      restarted
        .prepare(
          `SELECT id, status, finished_at, error_summary
             FROM library_scan_runs ORDER BY id`
        )
        .all(),
      [
        {
          id: 'previous-queued',
          status: 'failed',
          finished_at: recoveredAt,
          error_summary: INTERRUPTED_LIBRARY_SCAN_ERROR
        },
        {
          id: 'previous-running',
          status: 'failed',
          finished_at: recoveredAt,
          error_summary: INTERRUPTED_LIBRARY_SCAN_ERROR
        }
      ]
    )
    assert.deepEqual(
      restarted
        .prepare(
          `SELECT library_id, active_run_id, last_status, last_finished_at,
                  last_summary_json, last_error, revision
             FROM media_library_scan_state
            WHERE library_id IN (?, ?)
            ORDER BY library_id`
        )
        .all(first.id, second.id),
      [
        {
          library_id: first.id,
          active_run_id: null,
          last_status: 'failed',
          last_finished_at: recoveredAt,
          last_summary_json: null,
          last_error: INTERRUPTED_LIBRARY_SCAN_ERROR,
          revision: 2
        },
        {
          library_id: second.id,
          active_run_id: null,
          last_status: 'failed',
          last_finished_at: recoveredAt,
          last_summary_json: null,
          last_error: INTERRUPTED_LIBRARY_SCAN_ERROR,
          revision: 2
        }
      ]
    )

    beginLibraryScanRun({
      libraryId: first.id,
      runId: 'current-process-run',
      configRevision: 1,
      trigger: 'manual',
      startedAt: '2026-08-29T00:01:00.000Z'
    })
    assert.deepEqual(
      restarted
        .prepare('SELECT status, finished_at, error_summary FROM library_scan_runs WHERE id = ?')
        .get('current-process-run'),
      { status: 'running', finished_at: null, error_summary: null }
    )
  })

  it('releases archive and root-migration busy gates after restart recovery', () => {
    const archiveRoot = path.join(tempRoot, 'archive-after-recovery')
    const sourceRoot = path.join(tempRoot, 'migrate-after-recovery')
    const targetRoot = path.join(tempRoot, 'migration-target')
    fs.mkdirSync(archiveRoot)
    fs.mkdirSync(sourceRoot)
    fs.mkdirSync(targetRoot)
    const archiveCandidate = createMediaLibrary({
      name: 'Archive after recovery',
      roots: [{ path: archiveRoot }]
    })
    const source = createMediaLibrary({
      name: 'Migrate after recovery',
      roots: [{ path: sourceRoot }]
    })
    const target = createMediaLibrary({ name: 'Migration target', roots: [{ path: targetRoot }] })
    const databasePath = path.join(tempRoot, 'library.db')
    const insertRun = getDb().prepare(
      `INSERT INTO library_scan_runs (
         id, library_id, config_revision, trigger, status, started_at
       ) VALUES (?, ?, 1, 'manual', 'running', '2026-08-28T23:00:00.000Z')`
    )
    insertRun.run('archive-stale-run', archiveCandidate.id)
    insertRun.run('migration-stale-run', source.id)
    getDb()
      .prepare(
        'INSERT OR IGNORE INTO media_library_scan_state (library_id) VALUES (?), (?)'
      )
      .run(archiveCandidate.id, source.id)
    const setActive = getDb().prepare(
      `UPDATE media_library_scan_state
          SET active_run_id = ?, last_status = 'running',
              last_started_at = '2026-08-28T23:00:00.000Z'
        WHERE library_id = ?`
    )
    setActive.run('archive-stale-run', archiveCandidate.id)
    setActive.run('migration-stale-run', source.id)

    closeDatabase()
    const restarted = initDatabaseAtPath(databasePath)
    recoverInterruptedLibraryScanRuns(restarted, '2026-08-29T00:00:00.000Z')

    const archived = archiveMediaLibrary({
      libraryId: archiveCandidate.id,
      expectedRevision: archiveCandidate.revision
    })
    assert.equal(archived.status, 'archived')
    const migrationPreview = createMediaLibraryRootMigrationRepo(restarted, {
      isLocalAccessible: fs.existsSync
    }).preview({
      sourceLibraryId: source.id,
      targetLibraryId: target.id,
      rootId: source.roots[0].id
    })
    assert.equal(migrationPreview.sourceLibraryId, source.id)
    assert.equal(migrationPreview.targetLibraryId, target.id)
  })

  it('returns an empty snapshot before the first run and rejects an unknown library', () => {
    const root = path.join(tempRoot, 'library')
    fs.mkdirSync(root)
    const library = createMediaLibrary({ name: 'Empty', roots: [{ path: root }] })

    assert.deepEqual(getLatestLibraryScanSnapshot(library.id), {
      summary: null,
      audit: null,
      unrecognized: []
    })
    assert.throws(() => getLatestLibraryScanSnapshot(99_999), /媒体库不存在/)
  })
})

it('reads a scoped audit header without loading audit JSON or pending path arrays',async()=>{
 const {readScanAuditHeader}=await import('../services/scanAuditReadHeader')
 const directory=path.join(tempRoot,'header');fs.mkdirSync(directory)
 const library=createMediaLibrary({name:'Header',roots:[{path:directory}]})
 persistSuccessfulRun({libraryId:library.id,rootId:library.roots[0].id,runId:'header-run',filePath:path.join(directory,'unknown.mp4')})
 const expected=getLatestLibraryScanSnapshot(library.id),db=getDb(),prepare=db.prepare.bind(db),queries:string[]=[]
 // The header must not parse even an invalid/large audit body; the page reader validates it separately.
 db.prepare('UPDATE library_scan_runs SET audit_json=? WHERE id=?').run('x'.repeat(2*1024*1024),'header-run')
 db.prepare=((sql:string)=>{queries.push(sql);assert.doesNotMatch(sql,/SELECT\s+audit_json|json_each|json_extract|SELECT\s+root_id,\s*file_path/i);return prepare(sql)}) as typeof db.prepare
 try{
  const header=readScanAuditHeader(db,library.id)
  assert.deepEqual(header,{summary:expected.summary,snapshot:{libraryId:library.id,runId:'header-run',finishedAt:expected.summary!.finishedAt},unrecognizedCount:1})
  assert.ok(queries.some(sql=>sql.includes('COUNT(*)')))
  assert.equal('audit' in header,false);assert.equal('unrecognized' in header,false)
  assert.throws(()=>readScanAuditHeader(db,0),/ID/)
  assert.throws(()=>readScanAuditHeader(db,99999),/不存在/)
 }finally{db.prepare=prepare}
})

it('keeps summary failure semantics and rejects oversized summary/header payloads',async()=>{
 const {readScanAuditHeader}=await import('../services/scanAuditReadHeader'),{SCAN_AUDIT_HEADER_BYTES}=await import('../services/scanAuditReadPolicy')
 const directory=path.join(tempRoot,'header-errors');fs.mkdirSync(directory)
 const library=createMediaLibrary({name:'Header errors',roots:[{path:directory}]})
 persistSuccessfulRun({libraryId:library.id,rootId:library.roots[0].id,runId:'header-errors',filePath:path.join(directory,'unknown.mp4')})
 const db=getDb(),expected=getLatestLibraryScanSnapshot(library.id).summary!
 const update=(value:string)=>db.prepare('UPDATE media_library_scan_state SET last_summary_json=? WHERE library_id=?').run(value,library.id)
 for(const raw of ['{bad',JSON.stringify({...expected,libraryId:999})]){update(raw);assert.deepEqual(readScanAuditHeader(db,library.id),{summary:null,snapshot:null,unrecognizedCount:1})}
 update(JSON.stringify({...expected,padding:'x'.repeat(SCAN_AUDIT_HEADER_BYTES)}));assert.throws(()=>readScanAuditHeader(db,library.id),/byte budget/)
 const base={...expected,padding:''},raw=JSON.stringify({...base,padding:'x'.repeat(SCAN_AUDIT_HEADER_BYTES-Buffer.byteLength(JSON.stringify(base))-1)})
 assert.ok(Buffer.byteLength(raw)<SCAN_AUDIT_HEADER_BYTES);update(raw);assert.throws(()=>readScanAuditHeader(db,library.id),/byte budget/)
 update(JSON.stringify(expected));assert.deepEqual(readScanAuditHeader(db,library.id).summary,expected)
})

it('keeps header summary, audit availability and unrecognized count in one WAL snapshot',async()=>{
 const {default:Database}=await import('better-sqlite3'),{readScanAuditHeader}=await import('../services/scanAuditReadHeader')
 const directory=path.join(tempRoot,'header-snapshot');fs.mkdirSync(directory)
 const library=createMediaLibrary({name:'Header snapshot',roots:[{path:directory}]})
 persistSuccessfulRun({libraryId:library.id,rootId:library.roots[0].id,runId:'old-header',filePath:path.join(directory,'unknown.mp4')})
 const db=getDb(),old=getLatestLibraryScanSnapshot(library.id).summary!,next={...old,runId:'new-header',finishedAt:'later'},other=new Database(path.join(tempRoot,'library.db'))
 const prepare=db.prepare.bind(db);let changed=false
 db.prepare=((sql:string)=>{
  const statement=prepare(sql)
  if(sql.startsWith('SELECT last_summary_json AS value')){
   const get=statement.get.bind(statement)
   statement.get=((...args:unknown[])=>{
    const row=get(...args)
    if(!changed){changed=true;other.transaction(()=>{other.prepare('UPDATE media_library_scan_state SET last_summary_json=? WHERE library_id=?').run(JSON.stringify(next),library.id);other.prepare('DELETE FROM library_unrecognized_files WHERE library_id=?').run(library.id)})()}
    return row
   }) as typeof statement.get
  }
  return statement
 }) as typeof db.prepare
 try{
  assert.deepEqual(readScanAuditHeader(db,library.id),{summary:old,snapshot:{libraryId:library.id,runId:old.runId,finishedAt:old.finishedAt},unrecognizedCount:1})
  assert.equal(changed,true)
  assert.deepEqual(readScanAuditHeader(db,library.id),{summary:next,snapshot:null,unrecognizedCount:0})
 }finally{db.prepare=prepare;other.close()}
})

function replacementFixture() {
  const firstPath = path.join(tempRoot, 'replace-first')
  const secondPath = path.join(tempRoot, 'replace-second')
  fs.mkdirSync(firstPath)
  fs.mkdirSync(secondPath)
  const library = createMediaLibrary({ name: 'Replacement', roots: [{ path: firstPath }, { path: secondPath }] })
  const [first, second] = library.roots
  persistSuccessfulRun({ libraryId: library.id, rootId: first.id, runId: 'old-first', filePath: path.join(firstPath, 'old.mp4') })
  persistSuccessfulRun({ libraryId: library.id, rootId: second.id, runId: 'old-second', filePath: path.join(secondPath, 'kept.mp4') })
  const next = () => beginSuccessfulRun({ libraryId: library.id, rootId: first.id, runId: 'replacement', filePath: path.join(firstPath, 'new.mp4') })
  return { library, first, second, next }
}

function persistedReplacementState(libraryId: number) {
  const db = getDb()
  return {
    runs: db.prepare('SELECT * FROM library_scan_runs WHERE library_id=? ORDER BY id').all(libraryId),
    state: db.prepare('SELECT * FROM media_library_scan_state WHERE library_id=?').get(libraryId),
    files: db.prepare('SELECT * FROM library_unrecognized_files WHERE library_id=? ORDER BY root_id,normalized_path').all(libraryId)
  }
}

describe('finishLibraryScanRun unrecognized replacement transaction', () => {
  it('finishes with 40000 replacement root IDs without exceeding SQLite bind limits', () => {
    const { library, first, second, next } = replacementFixture()
    const input = next()
    input.replaceUnrecognizedRootIds = [first.id, ...Array.from({ length: 39_999 }, (_, index) => 1_000_000 + index)]
    assert.equal(input.replaceUnrecognizedRootIds.length, 40_000)
    finishLibraryScanRun(input)
    const latest = getLatestLibraryScanSnapshot(library.id)
    assert.deepEqual(latest.summary, input.summary)
    assert.deepEqual(latest.audit, input.audit)
    assert.deepEqual(latest.unrecognized, [
      { rootId: first.id, filePath: input.unrecognizedFiles![0].filePath },
      { rootId: second.id, filePath: path.join(second.path, 'kept.mp4') }
    ])
    assert.deepEqual(getDb().prepare('SELECT status,finished_at FROM library_scan_runs WHERE id=?').get(input.runId),
      { status: 'completed', finished_at: input.summary.finishedAt })
    assert.deepEqual(getDb().prepare('SELECT active_run_id,last_status FROM media_library_scan_state WHERE library_id=?').get(library.id),
      { active_run_id: null, last_status: 'completed' })
  })

  it('deduplicates replacement roots and skips incoming files outside the selected roots', () => {
    const { library, first, second, next } = replacementFixture()
    const input = next()
    input.replaceUnrecognizedRootIds = [first.id, first.id, first.id]
    input.unrecognizedFiles = [input.unrecognizedFiles![0],
      { rootId: second.id, filePath: '/must-not-insert', normalizedPath: '/must-not-insert' },
      { rootId: 999_999, filePath: '/missing-root', normalizedPath: '/missing-root' }]
    finishLibraryScanRun(input)
    assert.deepEqual(getLatestLibraryScanSnapshot(library.id).unrecognized, [
      { rootId: first.id, filePath: input.unrecognizedFiles[0].filePath },
      { rootId: second.id, filePath: path.join(second.path, 'kept.mp4') }
    ])
  })

  it('clears selected roots when there are no matching incoming files and preserves other roots', () => {
    const { library, first, second, next } = replacementFixture()
    const input = next()
    input.replaceUnrecognizedRootIds = [first.id, first.id]
    input.unrecognizedFiles = [{ rootId: second.id, filePath: '/not-selected', normalizedPath: '/not-selected' }]
    finishLibraryScanRun(input)
    assert.deepEqual(getLatestLibraryScanSnapshot(library.id).unrecognized,
      [{ rootId: second.id, filePath: path.join(second.path, 'kept.mp4') }])
  })

  for (const roots of [undefined, []] as const) it(`does not replace files for ${roots === undefined ? 'absent' : 'empty'} root targets`, () => {
    const { library, next } = replacementFixture()
    const input = next()
    const before = persistedReplacementState(library.id).files
    input.replaceUnrecognizedRootIds = roots
    finishLibraryScanRun(input)
    assert.deepEqual(persistedReplacementState(library.id).files, before)
  })

  for (const status of ['failed', 'cancelled'] as const) it(`${status} run never replaces preexisting unrecognized rows`, () => {
    const { library, first, next } = replacementFixture()
    const input = next()
    const before = persistedReplacementState(library.id).files
    input.status = status
    input.summary.status = status
    input.audit.status = status
    input.replaceUnrecognizedRootIds = [first.id, ...Array.from({ length: 39_999 }, (_, index) => 1_000_000 + index)]
    finishLibraryScanRun(input)
    assert.deepEqual(persistedReplacementState(library.id).files, before)
    assert.deepEqual(getLatestLibraryScanSnapshot(library.id).summary, input.summary)
    assert.deepEqual(getDb().prepare('SELECT status FROM library_scan_runs WHERE id=?').get(input.runId), { status })
  })

  it('rolls back run, state and all original unrecognized rows when a duplicate normalized path fails insertion', () => {
    const { library, next } = replacementFixture()
    const input = next()
    const before = persistedReplacementState(library.id)
    const file = input.unrecognizedFiles![0]
    input.unrecognizedFiles = [file, { ...file, filePath: `${file.filePath}.duplicate` }]
    assert.throws(() => finishLibraryScanRun(input), /UNIQUE constraint failed/)
    assert.deepEqual(persistedReplacementState(library.id), before,
      'run completion, revision/summary update, deletion and first insert must all roll back')
    assert.deepEqual(getDb().prepare('SELECT status,finished_at,summary_json,audit_json FROM library_scan_runs WHERE id=?').get(input.runId),
      { status: 'running', finished_at: null, summary_json: null, audit_json: null })
    input.unrecognizedFiles = [file]
    finishLibraryScanRun(input)
    assert.equal(getLatestLibraryScanSnapshot(library.id).summary?.runId, input.runId)
  })
})

it('does not hold a writer lock during audit stringify before the deferred transaction’s first SQL statement', async () => {
  const { default: Database } = await import('better-sqlite3')
  const { library, next } = replacementFixture()
  const unrelatedPath = path.join(tempRoot, 'unrelated-library')
  fs.mkdirSync(unrelatedPath)
  const unrelated = createMediaLibrary({ name: 'Before stringify', roots: [{ path: unrelatedPath }] })
  const input = next()
  const other = new Database(path.join(tempRoot, 'library.db'), { timeout: 0 })
  const stringify = JSON.stringify
  let intercepted = 0
  try {
    JSON.stringify = ((value: unknown, ...args: unknown[]) => {
      if (value === input.audit) {
        intercepted++
        assert.equal(getDb().inTransaction, true, 'the deferred transaction has begun')
        assert.equal(other.pragma('busy_timeout', { simple: true }), 0)
        const result = other.prepare('UPDATE media_libraries SET name=? WHERE id=?')
          .run('Written during stringify', unrelated.id)
        assert.equal(result.changes, 1, 'a second writer must succeed without waiting')
      }
      return Reflect.apply(stringify, JSON, [value, ...args])
    }) as typeof JSON.stringify
    finishLibraryScanRun(input)
  } finally {
    JSON.stringify = stringify
    other.close()
  }
  assert.equal(intercepted, 1)
  assert.deepEqual(getDb().prepare('SELECT name FROM media_libraries WHERE id=?').get(unrelated.id),
    { name: 'Written during stringify' })
  assert.deepEqual(getLatestLibraryScanSnapshot(library.id).audit, input.audit)
})

it('does not delete another library’s unrecognized rows even when its root ID is in the replacement set', () => {
  const { library, first, second, next } = replacementFixture()
  const otherPath = path.join(tempRoot, 'replacement-other-library')
  fs.mkdirSync(otherPath)
  const other = createMediaLibrary({ name: 'Other replacement scope', roots: [{ path: otherPath }] })
  const otherRoot = other.roots[0]
  persistSuccessfulRun({ libraryId: other.id, rootId: otherRoot.id, runId: 'other-preserved',
    filePath: path.join(otherPath, 'untouched.mp4') })
  const beforeOther = persistedReplacementState(other.id)
  const input = next()
  input.replaceUnrecognizedRootIds = [first.id, otherRoot.id, first.id, otherRoot.id]
  finishLibraryScanRun(input)
  assert.deepEqual(persistedReplacementState(other.id), beforeOther,
    'foreign root IDs must not delete files or change the other library’s run/state')
  assert.deepEqual(getLatestLibraryScanSnapshot(library.id).unrecognized, [
    { rootId: first.id, filePath: input.unrecognizedFiles![0].filePath },
    { rootId: second.id, filePath: path.join(second.path, 'kept.mp4') }
  ])
  assert.equal(getLatestLibraryScanSnapshot(library.id).summary?.runId, input.runId)
})
