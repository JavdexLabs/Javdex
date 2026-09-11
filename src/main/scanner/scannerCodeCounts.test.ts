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
import { scanFolders, ScanFoldersFailure, type ScanOptions } from './scanner'

let directory: string, media: string, previous: string | undefined, sequence = 0
beforeEach(() => {
  previous = process.env.JAVDEX_TEST_USER_DATA
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-code-counts-'))
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
  const request = { libraryId: library.id, runId: 'code-counts', roots: library.roots }
  beginLibraryScanRun({ ...request, configRevision: 1, trigger: 'manual', startedAt: 'start' })
  const writer = createScanAuditWriter(db, request)
  writer.start({ schemaVersion: 2, ...request, configRevision: 1, trigger: 'manual', startedAt: 'start', finishedAt: 'pending', status: 'success' })
  const sink: NonNullable<ScanOptions['auditSink']> = {
    recordFile: entry => writer.writeBatch('files', [entry]),
    readFileNfo: filePath => writer.readFileNfo(filePath), patchNfo: (filePath, nfo) => writer.patchNfo(filePath, nfo)
  }
  const options: ScanOptions = { auditSink: sink, autoMergeSameCodeResources: false, minImportDurationSeconds: 1,
    readDurationSeconds: async () => 120,
    readDirectory: async dir => (await fs.promises.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)) }
  const tempTables = () => db.prepare("SELECT name FROM sqlite_temp_master WHERE type='table' ORDER BY name").all() as { name: string }[]
  const audits = () => db.prepare("SELECT ordinal,entry_key,entry_json FROM library_scan_audit_entries WHERE run_id='code-counts' AND section='files' ORDER BY ordinal").all()
  return { db, request, options, tempTables, audits }
}

it('uses a TEMP code count table in actual summary scanning and releases it', async () => {
  const current = setup(['ABC-001.mp4'])
  const before = current.tempTables()
  let seen = false
  const result = await scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary',
    readDirectory: async dir => {
      seen = current.tempTables().some(row => row.name.startsWith('scan_code_counts_'))
      return current.options.readDirectory!(dir)
    }
  })
  assert.equal(result.imported, 1)
  assert.equal(seen, true)
  assert.deepEqual(current.tempTables(), before)
})

it('skips count storage entirely for summary automatic merging while preserving detailed results and audit', async context => {
  const names = ['ABC-001-CD1.mp4', 'ABC-001-CD2.mp4', 'DEF-002.strm', 'unknown.mp4']
  const legacy = setup(names)
  const detailed = await scanFolders(legacy.request, undefined, { ...legacy.options, autoMergeSameCodeResources: true })
  const audits = legacy.audits()
  const current = setup(names), prepare = current.db.prepare, exec = current.db.exec
  let countSql = 0
  context.mock.method(current.db, 'prepare', (sql: string) => { if (sql.includes('scan_code_counts_')) countSql++; return prepare.call(current.db, sql) })
  context.mock.method(current.db, 'exec', (sql: string) => { if (sql.includes('scan_code_counts_')) countSql++; return exec.call(current.db, sql) })
  const result = await scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary', autoMergeSameCodeResources: true })
  assert.equal(countSql, 0)
  assert.deepEqual(result, toScanCompletionResult(detailed))
  assert.deepEqual(current.audits(), audits)
})

it('allows cancellation before the first write in a small summary auto-merge scan with no count loop', async () => {
  const current = setup(['ABC-001.mp4']), controller = new AbortController()
  let timer: ReturnType<typeof setImmediate> | undefined, probes = 0
  const before = current.tempTables()
  try {
    const result = await scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary', autoMergeSameCodeResources: true,
      signal: controller.signal, yieldEvery: 10000,
      readDirectory: async dir => { const entries = await current.options.readDirectory!(dir); timer = setImmediate(() => controller.abort()); return entries },
      readDurationSeconds: async () => { probes++; return 120 }
    })
    assert.equal(result.cancelled, true); assert.equal(result.scannedFiles, 0); assert.equal(result.imported, 0)
    assert.equal(probes, 0); assert.deepEqual(current.audits(), [])
    assert.deepEqual(current.db.prepare('SELECT id FROM videos').all(), [])
    assert.deepEqual(current.tempTables(), before)
  } finally { if (timer) clearImmediate(timer) }
})

it('matches memory counts and audits across pages, roots, duplicates, invalid STRMs and NFO identities', async () => {
  const names = ['r1/ABC-001.mp4', 'r2/ABC-001-CD2.mp4', 'r1/VALID-002.mp4',
    'r1/VALID-002-CD2.strm', 'r2/VALID-002-CD3.strm', 'r1/unknown.mp4', 'r2/CON-004.mp4',
    ...Array.from({ length: 260 }, (_, index) => `r${index % 2 + 1}/ITEM-${1000 + index}.mp4`)]
  async function run(resultMode: 'detailed' | 'summary') {
    const current = setup(names, true)
    for (const name of names.filter(name => name.endsWith('.strm'))) fs.writeFileSync(path.join(media, name), 'invalid STRM')
    const result = await scanFolders(current.request, undefined, { ...current.options, resultMode, autoImportLocalNfo: true,
      readDirectory: async dir => { const entries = await current.options.readDirectory!(dir); return [...entries, entries[0]] },
      localNfoService: {
        inspectIdentity: anchor => ({ status: path.basename(anchor.anchorPath) === 'unknown.mp4' || anchor.anchorPath.endsWith('CON-004.mp4') ? 'found' : 'missing',
          code: anchor.anchorPath.endsWith('CON-004.mp4') ? 'OTHER-005' : path.basename(anchor.anchorPath) === 'unknown.mp4' ? 'NFO-003' : null, warnings: [] }),
        apply: async () => ({ disposition: 'imported', warnings: [] })
      }
    })
    assert.deepEqual(current.tempTables(), [])
    assert.ok(current.db.prepare("SELECT id FROM videos WHERE code='VALID-002'").get(), 'multiple invalid STRMs must not force valid local confirmation')
    assert.ok(current.db.prepare("SELECT id FROM videos WHERE code='NFO-003'").get())
    assert.equal(current.db.prepare("SELECT id FROM videos WHERE code='CON-004'").get(), undefined)
    return { result: toScanCompletionResult(result), audits: current.audits() }
  }
  assert.deepEqual(await run('summary'), await run('detailed'))
})

for (const phase of ['flush', 'adjustment'] as const) it(`cancels during code ${phase} before importing with all TEMP resources removed`, async () => {
  const names = phase === 'flush' ? Array.from({ length: 300 }, (_, index) => `CODE-${1000 + index}.mp4`)
    : ['ABC-001.mp4', ...Array.from({ length: 12 }, (_, index) => `ABC-001-CD${index + 2}.strm`)]
  const current = setup(names), controller = new AbortController()
  if (phase === 'adjustment') for (const name of names.filter(name => name.endsWith('.strm'))) fs.writeFileSync(path.join(media, name), 'invalid')
  let timer: ReturnType<typeof setImmediate> | undefined, fired = false, outside = false
  current.db.function('schedule_count_cancel', () => {
    if (!timer) timer = setImmediate(() => { outside = !current.db.inTransaction; fired = true; controller.abort() })
    return 0
  })
  try {
    const result = await scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary', signal: controller.signal, yieldEvery: 10000,
      readDirectory: async dir => {
        const table = current.tempTables().find(row => row.name.startsWith('scan_code_counts_'))!.name
        current.db.exec(`CREATE TEMP TRIGGER cancel_counts AFTER ${phase === 'flush' ? 'INSERT' : 'UPDATE'} ON "${table}" BEGIN SELECT schedule_count_cancel(); END`)
        return current.options.readDirectory!(dir)
      }
    })
    assert.equal(fired, true); assert.equal(outside, true); assert.equal(result.cancelled, true)
    assert.equal(result.scannedFiles, 0); assert.equal(result.imported, 0)
    assert.deepEqual(current.audits(), []); assert.deepEqual(current.tempTables(), [])
  } finally { if (timer) clearImmediate(timer) }
})

for (const operation of ['INSERT', 'UPDATE'] as const) it(`treats native count ${operation} failure as fatal before any imports`, async () => {
  const current = setup(operation === 'INSERT' ? ['AAA-001.mp4', 'BBB-002.mp4'] : ['ABC-001.mp4', 'ABC-001-CD2.strm'])
  if (operation === 'UPDATE') fs.writeFileSync(path.join(media, 'ABC-001-CD2.strm'), 'invalid')
  await assert.rejects(scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary',
    readDirectory: async dir => {
      const table = current.tempTables().find(row => row.name.startsWith('scan_code_counts_'))!.name
      current.db.exec(`CREATE TEMP TRIGGER fault_counts BEFORE ${operation} ON "${table}" BEGIN SELECT RAISE(ABORT,'count ${operation} fault'); END`)
      return current.options.readDirectory!(dir)
    }
  }), error => {
    assert.ok(error instanceof ScanFoldersFailure); assert.match(error.message, /count .* fault/)
    assert.equal(error.partialResult.imported, 0); assert.equal(error.partialResult.failed, 0)
    return true
  })
  assert.deepEqual(current.audits(), []); assert.deepEqual(current.tempTables(), [])
})

it('does not downgrade a native main-loop count SELECT failure to processing_failure and preserves prior imports', async () => {
  const current = setup(['AAA-001.mp4', 'BBB-002.mp4'])
  let probes = 0
  await assert.rejects(scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary',
    readDurationSeconds: async () => {
      probes++
      if (probes === 2) {
        const table = current.tempTables().find(row => row.name.startsWith('scan_code_counts_'))!.name
        current.db.exec(`DROP TABLE temp."${table}"`)
      }
      return 120
    }
  }), error => {
    assert.ok(error instanceof ScanFoldersFailure); assert.match(error.message, /no such table/)
    assert.equal(error.partialResult.imported, 1); assert.equal(error.partialResult.scannedFiles, 2)
    assert.equal(error.partialResult.failed, 0)
    return true
  })
  assert.equal(probes, 2)
  assert.equal(current.audits().length, 1); assert.deepEqual(current.tempTables(), [])
})

it('cleans the first inventory if the second factory fails after creating its table', async context => {
  const current = setup(['AAA-001.mp4']), exec = current.db.exec
  let inventoryDrops = 0, directoryReads = 0
  context.mock.method(current.db, 'exec', (sql: string) => {
    if (sql.includes('DROP TABLE IF EXISTS temp.scan_file_inventory_')) inventoryDrops++
    const result = exec.call(current.db, sql)
    if (sql.includes('CREATE TEMP TABLE scan_code_counts_')) throw new Error('second factory fault')
    return result
  })
  await assert.rejects(scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary',
    readDirectory: async () => { directoryReads++; return [] }
  }), /second factory fault/)
  assert.equal(inventoryDrops, 1); assert.equal(directoryReads, 0)
  assert.deepEqual(current.tempTables(), [])
})

it('attempts both disposers, preserves the first cleanup error and retries both after early-tail faults', async context => {
  const current = setup(['AAA-001.mp4']), exec = current.db.exec
  const drops = { inventory: 0, counts: 0 }
  context.mock.method(current.db, 'exec', (sql: string) => {
    if (sql.includes('DROP TABLE IF EXISTS temp.scan_file_inventory_') && ++drops.inventory === 1) throw new Error('first inventory DROP fault')
    if (sql.includes('DROP TABLE IF EXISTS temp.scan_code_counts_') && ++drops.counts === 1) throw new Error('second counts DROP fault')
    return exec.call(current.db, sql)
  })
  await assert.rejects(scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary' }), error => {
    assert.ok(error instanceof ScanFoldersFailure); assert.match(error.message, /first inventory DROP fault/)
    assert.equal(error.partialResult.imported, 1); assert.equal(error.partialResult.failed, 0)
    return true
  })
  assert.deepEqual(drops, { inventory: 2, counts: 2 })
  assert.equal(current.audits().length, 1); assert.deepEqual(current.tempTables(), [])
})

it('preserves an original scan error while still attempting both failing disposers', async context => {
  const current = setup(['AAA-001.mp4']), exec = current.db.exec
  let drops = 0
  context.mock.method(current.db, 'exec', (sql: string) => {
    if (/DROP TABLE IF EXISTS temp.scan_(file_inventory|code_counts)_/.test(sql)) { drops++; throw new Error('secondary cleanup') }
    return exec.call(current.db, sql)
  })
  try {
    await assert.rejects(scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary', readDirectory: async () => { throw new Error('original discovery') } }), /original discovery/)
    assert.equal(drops, 2)
  } finally {
    context.mock.restoreAll()
    for (const row of current.tempTables()) exec.call(current.db, `DROP TABLE "${row.name}"`)
  }
})

it('keeps STRM relocation revision stable after count preparation and resource-free audit writes', async context => {
  const current = setup(['AAA-001.strm', 'BBB-002.strm', 'CCC-003.strm', 'unknown.strm']), prepare = current.db.prepare
  let rebuilds = 0
  context.mock.method(current.db, 'prepare', (sql: string) => {
    if (sql.includes('strm_source_path AS source_path') && sql.includes('ORDER BY id')) rebuilds++
    return prepare.call(current.db, sql)
  })
  const result = await scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary' })
  assert.equal(result.imported, 3); assert.equal(result.unrecognizedCount, 1)
  assert.equal(rebuilds, 1)
  assert.equal(current.audits().length, 4)
})
