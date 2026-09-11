import { afterEach, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toScanCompletionResult } from '@shared/scanResult'
import { closeDatabase, initDatabaseAtPath } from '../db/database'
import { createMediaLibrary } from '../db/mediaLibraryRepo'
import { beginLibraryScanRun } from '../db/libraryScanRepo'
import { createScanAuditWriter } from '../db/scanAuditWriter'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import { localNfoScanService } from '../services/localNfoScanService'
import { scanFolders, ScanFoldersFailure, type ScanOptions } from './scanner'

let directory: string, media: string, previous: string | undefined, sequence = 0
beforeEach(() => {
  previous = process.env.JAVDEX_TEST_USER_DATA
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-nfo-workset-'))
  media = path.join(directory, 'media'); fs.mkdirSync(media)
  process.env.JAVDEX_TEST_USER_DATA = directory
})
afterEach(() => {
  closeDatabase(); resetSettingsCacheForTests()
  if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previous
  fs.rmSync(directory, { recursive: true, force: true })
})
function setup(names: string[], multipleRoots = false) {
  closeDatabase(); resetSettingsCacheForTests()
  for (const name of names) {
    const file = path.join(media, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, name.endsWith('.strm') ? `https://example.test/${name}` : 'synthetic video')
  }
  const db = initDatabaseAtPath(path.join(directory, `catalog-${++sequence}.db`))
  const library = createMediaLibrary({ name: 'Inventory', roots: multipleRoots ? [{ path: path.join(media, 'r2') }, { path: path.join(media, 'r1') }] : [{ path: media }] })
  const request = { libraryId: library.id, runId: 'nfo-workset', roots: library.roots }
  beginLibraryScanRun({ ...request, configRevision: 1, trigger: 'manual', startedAt: 'start' })
  const writer = createScanAuditWriter(db, request)
  writer.start({ schemaVersion: 2, ...request, configRevision: 1, trigger: 'manual', startedAt: 'start', finishedAt: 'pending', status: 'success' })
  const sink: NonNullable<ScanOptions['auditSink']> = {
    recordFile: entry => writer.writeBatch('files', [entry]),
    readFileNfo: filePath => writer.readFileNfo(filePath), patchNfo: (filePath, nfo) => writer.patchNfo(filePath, nfo)
  }
  const options: ScanOptions = { auditSink: sink, autoMergeSameCodeResources: true, autoImportLocalNfo: true, minImportDurationSeconds: 1,
    readDurationSeconds: async () => 120,
    readDirectory: async dir => (await fs.promises.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)) }
  const tempTables = () => db.prepare("SELECT name FROM sqlite_temp_master WHERE type='table' ORDER BY name").all() as { name: string }[]
  const audits = () => db.prepare("SELECT ordinal,entry_key,entry_json FROM library_scan_audit_entries WHERE run_id='nfo-workset' AND section='files' ORDER BY ordinal").all()
  return { db, request, options, tempTables, audits }
}


function writeMovie(folder: string, code: string, title: string) {
  fs.writeFileSync(path.join(folder, 'movie.nfo'), `<movie><num>${code}</num><title>${title}</title><plot>Actual local metadata</plot></movie>`)
}

it('matches detailed real NFO results and audits for several videos and many anchors while TEMP remains alive through apply', async () => {
  const names = [...Array.from({ length: 24 }, (_, index) => `r1/ABC-001-CD${index + 1}.mp4`),
    ...Array.from({ length: 12 }, (_, index) => `r2/DEF-002-CD${index + 1}.strm`)]
  async function run(resultMode: 'summary' | 'detailed') {
    const current = setup(names, true)
    writeMovie(path.join(media, 'r1'), 'ABC-001', 'Actual ABC title')
    writeMovie(path.join(media, 'r2'), 'DEF-002', 'Actual DEF title')
    const alive: boolean[] = [], scratchReleased: boolean[] = [], counts: number[] = []
    const result = await scanFolders(current.request, undefined, { ...current.options, resultMode,
      localNfoService: {
        inspectIdentity: anchor => localNfoScanService.inspectIdentity(anchor),
        apply: async (videoId, code, anchors, beforeCommit) => {
          counts.push(anchors.length)
          alive.push(current.tempTables().some(row => row.name.includes('nfo')))
          scratchReleased.push(current.tempTables().every(row => !/scan_file_inventory_|scan_code_counts_/.test(row.name)))
          return localNfoScanService.apply(videoId, code, anchors, beforeCommit)
        }
      }
    })
    assert.deepEqual(counts, [12, 24])
    assert.deepEqual(alive, [resultMode === 'summary', resultMode === 'summary'])
    assert.deepEqual(scratchReleased, [true, true])
    assert.deepEqual(current.db.prepare('SELECT code,title,scraped_status FROM videos ORDER BY code').all(), [
      { code: 'ABC-001', title: 'Actual ABC title', scraped_status: 1 },
      { code: 'DEF-002', title: 'Actual DEF title', scraped_status: 1 }
    ])
    assert.deepEqual(current.tempTables(), [])
    return { result: toScanCompletionResult(result), audits: current.audits() }
  }
  assert.deepEqual(await run('summary'), await run('detailed'))
})

it('retains the discovered sidecar and directory identity snapshot across filesystem changes before apply', async () => {
  const current = setup(['ABC-001-CD1.mp4', 'ABC-001-CD2.mp4'])
  writeMovie(media, 'ABC-001', 'Snapshot movie title')
  let changed = false
  const result = await scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary',
    localNfoService: {
      inspectIdentity: anchor => {
        const result = localNfoScanService.inspectIdentity(anchor)
        if (!changed) {
          changed = true
          fs.writeFileSync(path.join(media, 'ABC-001-CD1.nfo'), '<movie><num>ABC-001</num><title>Late exact title</title></movie>')
          fs.writeFileSync(path.join(media, 'OTHER-999.mp4'), 'late sibling')
        }
        return result
      },
      apply: (videoId, code, anchors, beforeCommit) => localNfoScanService.apply(videoId, code, anchors, beforeCommit)
    }
  })
  assert.equal(result.scannedFiles, 2)
  assert.equal(changed, true)
  assert.deepEqual(current.db.prepare('SELECT code,title FROM videos').all(), [{ code: 'ABC-001', title: 'Snapshot movie title' }])
  assert.deepEqual(current.tempTables(), [])
})

it('preserves duplicate-path preflight overwrite and final warning audit semantics', async () => {
  async function run(resultMode: 'summary' | 'detailed') {
    const current = setup(['ABC-001.mp4']), file = path.join(media, 'ABC-001.mp4')
    let inspected = 0
    const result = await scanFolders({ ...current.request, filePaths: [file, file] }, undefined, { ...current.options, resultMode,
      localNfoService: {
        inspectIdentity: () => ({ status: 'found', code: 'ABC-001', warnings: [++inspected === 1 ? 'old preflight' : 'latest preflight'] }),
        apply: async () => ({ disposition: 'imported', warnings: ['apply warning'] })
      }
    })
    assert.equal(inspected, 2); assert.equal(result.scannedFiles, 2)
    const audits = current.audits()
    assert.equal(audits.length, 1)
    assert.match(JSON.stringify(audits), /latest preflight/)
    assert.doesNotMatch(JSON.stringify(audits), /old preflight/)
    assert.deepEqual(current.tempTables(), [])
    return { result: toScanCompletionResult(result), audits }
  }
  assert.deepEqual(await run('summary'), await run('detailed'))
})

it('does not create or query any NFO workset with summary NFO disabled', async context => {
  const current = setup(['ABC-001.mp4']), prepare = current.db.prepare, exec = current.db.exec
  let nfoSql = 0, inspected = 0, applied = 0
  context.mock.method(current.db, 'prepare', (sql: string) => { if (/scan_nfo/.test(sql)) nfoSql++; return prepare.call(current.db, sql) })
  context.mock.method(current.db, 'exec', (sql: string) => { if (/scan_nfo/.test(sql)) nfoSql++; return exec.call(current.db, sql) })
  const result = await scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary', autoImportLocalNfo: false,
    localNfoService: {
      inspectIdentity: () => { inspected++; return { status: 'missing', code: null, warnings: [] } },
      apply: async () => { applied++; return { disposition: 'none', warnings: [] } }
    }
  })
  assert.equal(result.imported, 1)
  assert.equal(nfoSql, 0); assert.equal(inspected, 0); assert.equal(applied, 0)
})

for (const phase of ['inspect', 'apply'] as const) it(`keeps an actual SQL sidecar lookup failure fatal during ${phase}`, async () => {
  const current = setup(['ABC-001.mp4'])
  writeMovie(media, 'ABC-001', 'Original title')
  const breakSidecars = () => {
    const table = current.tempTables().find(row => row.name.includes('scan_nfo_workset_') && row.name.endsWith('_sidecars'))!.name
    current.db.exec(`DROP TABLE temp."${table}"`)
  }
  await assert.rejects(scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary',
    localNfoService: {
      inspectIdentity: anchor => { if (phase === 'inspect') breakSidecars(); return localNfoScanService.inspectIdentity(anchor) },
      apply: (videoId, code, anchors, beforeCommit) => { if (phase === 'apply') breakSidecars(); return localNfoScanService.apply(videoId, code, anchors, beforeCommit) }
    }
  }), error => {
    assert.ok(error instanceof ScanFoldersFailure); assert.match(error.message, /no such table/)
    assert.equal(error.partialResult.failed, 0)
    assert.equal(error.partialResult.imported, phase === 'apply' ? 1 : 0)
    return true
  })
  assert.equal(current.audits().length, phase === 'apply' ? 1 : 0)
  if (phase === 'apply') assert.deepEqual(current.db.prepare('SELECT scraped_status FROM videos').all(), [{ scraped_status: 0 }])
  assert.deepEqual(current.tempTables(), [])
})

for (const extension of ['mp4', 'strm']) for (const existingVideo of [false, true]) it(`rolls queue INSERT failure back with the ${extension} ${existingVideo ? 'existing-video resource' : 'new video'} and retries actual NFO`, async () => {
  const current = setup(['AAA-001.mp4', `BBB-002.${extension}`])
  fs.writeFileSync(path.join(media, 'BBB-002.nfo'), '<movie><num>BBB-002</num><title>Retried actual NFO</title></movie>')
  if (existingVideo) {
    current.db.prepare("INSERT INTO videos(code) VALUES('BBB-002')").run()
    current.db.prepare("INSERT INTO library_video_memberships(library_id,video_id,discovery_key) SELECT ?,id,1 FROM videos WHERE code='BBB-002'").run(current.request.libraryId)
  }
  let observed: unknown[] | undefined
  current.db.function('observe_queue_mutation', (resources, audits) => { observed = [resources, audits]; return 0 })
  await assert.rejects(scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary',
    readDirectory: async dir => {
      const table = current.tempTables().find(row => row.name.includes('scan_nfo_workset_') && row.name.endsWith('_queue'))!.name
      current.db.exec(`CREATE TEMP TRIGGER fail_nfo_queue AFTER INSERT ON "${table}" BEGIN
        SELECT observe_queue_mutation(
          (SELECT COUNT(*) FROM video_resources WHERE video_id=(SELECT id FROM videos WHERE code='BBB-002')),
          (SELECT COUNT(*) FROM library_scan_audit_entries WHERE section='files' AND entry_key LIKE '%BBB-002%'));
        SELECT RAISE(ABORT,'NFO queue INSERT fault'); END`)
      return current.options.readDirectory!(dir)
    }
  }), error => {
    assert.ok(error instanceof ScanFoldersFailure); assert.match(error.message, /NFO queue INSERT fault/)
    assert.equal(error.partialResult.imported, 1); assert.equal(error.partialResult.scannedFiles, 2)
    assert.equal(error.partialResult.failed, 0)
    return true
  })
  assert.deepEqual(observed, [1, 1], 'native fault occurs after current resource and file audit writes')
  assert.deepEqual(current.db.prepare("SELECT COUNT(*) AS n FROM video_resources WHERE video_id=(SELECT id FROM videos WHERE code='BBB-002')").get(), { n: 0 })
  assert.equal(Boolean(current.db.prepare("SELECT id FROM videos WHERE code='BBB-002'").get()), existingVideo)
  assert.equal(current.audits().length, 1, 'previous committed file audit survives; current file audit rolls back')
  assert.deepEqual(current.tempTables(), [])
  // TEMP trigger was dropped with its workset table. Rediscovery must still import the rolled-back file.
  const retry = await scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary' })
  assert.equal(retry.imported, 1)
  assert.deepEqual(current.db.prepare("SELECT title,scraped_status FROM videos WHERE code='BBB-002'").get(), { title: 'Retried actual NFO', scraped_status: 1 })
  assert.equal(current.audits().length, 2)
  assert.deepEqual(current.tempTables(), [])
})

it('keeps the workset alive while draining committed NFO audit warnings on cancellation and skips the next batch', async context => {
  const current = setup(['AAA-001-CD1.mp4', 'AAA-001-CD2.mp4', 'BBB-002.mp4']), controller = new AbortController()
  let applies = 0, aliveDuringCommit = false, queueReadsAfterCancel = 0
  const prepare = current.db.prepare
  context.mock.method(current.db, 'prepare', (sql: string) => {
    const statement = prepare.call(current.db, sql)
    if (sql.startsWith('SELECT q.ordinal,p.body') && sql.includes('_queue')) {
      const get = statement.get
      context.mock.method(statement, 'get', (...args: unknown[]) => {
        if (controller.signal.aborted) queueReadsAfterCancel++
        return Reflect.apply(get, statement, args)
      })
    }
    return statement
  })
  const result = await scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary', signal: controller.signal, yieldEvery: 1,
    localNfoService: {
      inspectIdentity: anchor => ({ status: 'found', code: path.basename(anchor.anchorPath).startsWith('AAA') ? 'AAA-001' : 'BBB-002', warnings: ['preflight'] }),
      apply: async (videoId, _code, _anchors, beforeCommit) => {
        applies++
        current.db.transaction(() => {
          current.db.prepare('UPDATE videos SET title=? WHERE id=?').run('Committed NFO title', videoId)
          beforeCommit?.({ disposition: 'imported', warnings: ['committed'] })
          aliveDuringCommit = current.tempTables().some(row => row.name.includes('scan_nfo_workset_'))
        })()
        controller.abort()
        // Any attempted hydration of the next batch now fails natively. Current audit drain must still finish.
        const queue = current.tempTables().find(row => row.name.includes('scan_nfo_workset_') && row.name.endsWith('_queue'))!.name
        current.db.exec(`DROP TABLE temp."${queue}"`)
        return { disposition: 'imported', warnings: ['committed', 'postcommit'] }
      }
    }
  })
  assert.equal(result.cancelled, true); assert.equal(result.imported, 3)
  assert.equal(applies, 1); assert.equal(aliveDuringCommit, true)
  assert.equal(queueReadsAfterCancel, 0, 'no next-video queue/body SELECT executes after cancellation')
  const audits = JSON.stringify(current.audits())
  assert.equal((audits.match(/postcommit/g) ?? []).length, 2, 'both committed anchors retain returned postcommit warnings')
  assert.deepEqual(current.tempTables(), [])
})

it('rolls real NFO business updates back with a native audit revision fault while disposing the workset', async () => {
  const current = setup(['ABC-001.mp4'])
  writeMovie(media, 'ABC-001', 'Must roll back')
  current.db.exec("CREATE TEMP TRIGGER fail_nfo_audit BEFORE UPDATE OF entry_json ON library_scan_audit_entries BEGIN SELECT RAISE(ABORT,'NFO audit revision fault'); END")
  await assert.rejects(scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary' }), error => {
    assert.ok(error instanceof ScanFoldersFailure); assert.match(error.message, /NFO audit revision fault/)
    assert.equal(error.partialResult.imported, 1); assert.equal(error.partialResult.failed, 0)
    return true
  })
  assert.deepEqual(current.db.prepare('SELECT title,scraped_status FROM videos').all(), [{ title: null, scraped_status: 0 }])
  assert.equal(current.audits().length, 1)
  assert.deepEqual(current.tempTables(), [])
})

it('disposes earlier scratch stores if creating the NFO workset fails', async context => {
  const current = setup(['ABC-001.mp4']), exec = current.db.exec
  const drops: string[] = []
  context.mock.method(current.db, 'exec', (sql: string) => {
    if (sql.includes('DROP TABLE')) drops.push(sql)
    const result = exec.call(current.db, sql)
    if (/CREATE TEMP TABLE .*scan_nfo_workset_/.test(sql)) throw new Error('NFO workset factory fault')
    return result
  })
  await assert.rejects(scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary', autoMergeSameCodeResources: false }), /NFO workset factory fault/)
  assert.ok(drops.some(sql => sql.includes('scan_file_inventory_')))
  assert.ok(drops.some(sql => sql.includes('scan_code_counts_')))
  assert.deepEqual(current.tempTables(), [])
})

it('tracks queue writes without rebuilding the STRM relocation index on each NFO candidate', async context => {
  const names = ['AAA-001.strm', 'BBB-002.strm', 'CCC-003.strm']
  const current = setup(names), prepare = current.db.prepare
  for (const name of names) fs.writeFileSync(path.join(media, name.replace('.strm', '.nfo')), `<movie><num>${name.replace('.strm', '')}</num><title>NFO title</title></movie>`)
  let rebuilds = 0
  context.mock.method(current.db, 'prepare', (sql: string) => {
    if (sql.includes('strm_source_path AS source_path') && sql.includes('ORDER BY id')) rebuilds++
    return prepare.call(current.db, sql)
  })
  const result = await scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary' })
  assert.equal(result.imported, 3); assert.equal(rebuilds, 1)
  assert.deepEqual(current.tempTables(), [])
})

it('attempts all three scratch cleanups without replacing an original discovery failure', async context => {
  const current = setup(['ABC-001.mp4']), exec = current.db.exec
  const attempted = new Set<string>()
  context.mock.method(current.db, 'exec', (sql: string) => {
    if (sql.includes('DROP TABLE')) {
      const kind = sql.includes('scan_file_inventory_') ? 'inventory' : sql.includes('scan_code_counts_') ? 'counts' : sql.includes('scan_nfo_workset_') ? 'nfo' : null
      if (kind) { attempted.add(kind); throw new Error(`secondary ${kind} cleanup fault`) }
    }
    return exec.call(current.db, sql)
  })
  try {
    await assert.rejects(scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary', autoMergeSameCodeResources: false,
      readDirectory: async () => { throw new Error('original NFO discovery fault') }
    }), error => {
      assert.ok(error instanceof ScanFoldersFailure)
      assert.match(error.message, /original NFO discovery fault/)
      assert.doesNotMatch(error.message, /secondary/)
      assert.equal(error.partialResult.imported, 0)
      return true
    })
    assert.deepEqual([...attempted].sort(), ['counts', 'inventory', 'nfo'])
    assert.deepEqual(current.audits(), [])
  } finally {
    context.mock.restoreAll()
    for (const row of current.tempTables().reverse()) exec.call(current.db, `DROP TABLE IF EXISTS temp."${row.name}"`)
  }
  assert.deepEqual(current.tempTables(), [])
})


it('preserves the native sidecar INSERT cause through directory discovery wrapping', async () => {
  const current = setup(['ABC-001.mp4'])
  writeMovie(media, 'ABC-001', 'NFO title')
  await assert.rejects(scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary',
    readDirectory: async dir => {
      const table = current.tempTables().find(row => row.name.includes('scan_nfo_workset_') && row.name.endsWith('_sidecars'))!.name
      current.db.exec(`CREATE TEMP TRIGGER fail_sidecar_discovery BEFORE INSERT ON "${table}" BEGIN SELECT RAISE(ABORT,'native sidecar INSERT fault'); END`)
      return current.options.readDirectory!(dir)
    }
  }), error => {
    assert.ok(error instanceof ScanFoldersFailure)
    assert.ok(error.cause instanceof Error)
    assert.match(error.cause.message, /无法读取媒体目录/)
    const worksetError = error.cause.cause
    assert.ok(worksetError instanceof Error)
    assert.equal(worksetError.name, 'ScanNfoWorksetError')
    assert.ok(worksetError.cause instanceof Error)
    assert.match(worksetError.cause.message, /native sidecar INSERT fault/)
    assert.equal(Reflect.get(worksetError.cause, 'code'), 'SQLITE_CONSTRAINT_TRIGGER')
    assert.equal(error.partialResult.imported, 0); assert.equal(error.partialResult.failed, 0)
    return true
  })
  assert.deepEqual(current.audits(), [])
  assert.deepEqual(current.tempTables(), [])
})
