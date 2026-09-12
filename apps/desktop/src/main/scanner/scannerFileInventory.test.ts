import { afterEach, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toScanCompletionResult } from '@shared/scanResult'
import { closeDatabase, initDatabaseAtPath } from '@library/db/database'
import { createMediaLibrary } from '@library/db/mediaLibraryRepo'
import { beginLibraryScanRun } from '@library/db/libraryScanRepo'
import { createScanAuditWriter } from '@library/db/scanAuditWriter'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import { scanFolders, ScanFoldersFailure, type ScanOptions } from './scanner'

let directory: string, media: string, previous: string | undefined, sequence = 0
beforeEach(() => {
  previous = process.env.JAVDEX_TEST_USER_DATA
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-file-inventory-'))
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
  const request = { libraryId: library.id, runId: 'inventory', roots: library.roots }
  beginLibraryScanRun({ ...request, configRevision: 1, trigger: 'manual', startedAt: 'start' })
  const writer = createScanAuditWriter(db, request)
  writer.start({ schemaVersion: 2, ...request, configRevision: 1, trigger: 'manual', startedAt: 'start', finishedAt: 'pending', status: 'success' })
  const sink: NonNullable<ScanOptions['auditSink']> = {
    recordFile: entry => writer.writeBatch('files', [entry]),
    readFileNfo: filePath => writer.readFileNfo(filePath), patchNfo: (filePath, nfo) => writer.patchNfo(filePath, nfo)
  }
  const options: ScanOptions = { auditSink: sink, autoMergeSameCodeResources: true, minImportDurationSeconds: 1,
    readDurationSeconds: async () => 120,
    readDirectory: async dir => (await fs.promises.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)) }
  const tempTables = () => db.prepare("SELECT name FROM sqlite_temp_master WHERE type='table' ORDER BY name").all() as { name: string }[]
  const audits = () => db.prepare("SELECT ordinal,entry_key,entry_json FROM library_scan_audit_entries WHERE run_id='inventory' AND section='files' ORDER BY ordinal").all()
  return { db, request, options, tempTables, audits }
}

it('uses a TEMP inventory for actual summary discovery and drops it before scan completion', async () => {
  const current = setup(['ABC-001.mp4'])
  const before = current.tempTables()
  let sawInventory = false
  const result = await scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary',
    readDirectory: async dir => {
      sawInventory = current.tempTables().length > before.length
      return current.options.readDirectory!(dir)
    }
  })
  assert.equal(result.imported, 1)
  assert.equal(sawInventory, true)
  assert.deepEqual(current.tempTables(), before)
})


it('matches detailed memory audits across multiple pages, root order and duplicate discovery paths', async () => {
  const names = ['r1/ABC-001.mp4', 'r2/DEF-002.strm',
    ...Array.from({ length: 160 }, (_, index) => `r1/unknown${index}.mp4`),
    ...Array.from({ length: 160 }, (_, index) => `r2/unknown${index}.mp4`)]
  async function run(resultMode: 'summary' | 'detailed') {
    const current = setup(names, true)
    const expectedTables = current.tempTables()
    const result = await scanFolders(current.request, undefined, { ...current.options, resultMode,
      readDirectory: async dir => {
        const entries = await current.options.readDirectory!(dir)
        return [...entries, entries[0]]
      },
      readDurationSeconds: async () => { assert.equal(current.db.inTransaction, false); return 120 }
    })
    assert.deepEqual(current.tempTables(), expectedTables)
    return { result: toScanCompletionResult(result), audits: current.audits() }
  }
  const detailed = await run('detailed')
  const summary = await run('summary')
  assert.equal(summary.result.scannedFiles, 324)
  assert.equal(summary.result.unrecognizedCount, 320)
  assert.deepEqual(summary, detailed)
  assert.ok(JSON.stringify(summary.audits[0]).includes('r2'), 'root request order is retained')
})

for (const targeted of [false, true]) it(`yields after the first TEMP flush and cancels before any import (${targeted ? 'targeted' : 'full'})`, async () => {
  const current = setup(Array.from({ length: 300 }, (_, index) => `unknown${index}.mp4`))
  const controller = new AbortController()
  const before = current.tempTables()
  let timer: ReturnType<typeof setImmediate> | undefined, flushedRows = 0, inspections = 0, probes = 0
  const abort = () => {
    assert.equal(current.db.inTransaction, false)
    const table = current.tempTables().find(row => !before.some(old => old.name === row.name))!
    flushedRows = (current.db.prepare(`SELECT COUNT(*) AS count FROM "${table.name}"`).get() as { count: number }).count
    controller.abort()
  }
  if (targeted) timer = setImmediate(abort)
  try {
    const result = await scanFolders({ ...current.request, ...(targeted ? {
      filePaths: Array.from({ length: 300 }, (_, index) => path.join(media, `unknown${index}.mp4`))
    } : {}) }, undefined, { ...current.options, resultMode: 'summary', signal: controller.signal,
      readDirectory: async dir => {
        const entries = await current.options.readDirectory!(dir)
        timer = setImmediate(abort)
        return entries
      },
      readDurationSeconds: async () => { probes++; return 120 },
      localNfoService: {
        inspectIdentity: () => { inspections++; return { status: 'missing', code: null, warnings: [] } },
        apply: async () => ({ disposition: 'none', warnings: [] })
      }
    })
    assert.equal(flushedRows, 256)
    assert.equal(result.cancelled, true); assert.equal(result.scannedFiles, 0); assert.equal(result.imported, 0)
    assert.equal(probes, 0); assert.equal(inspections, 0)
    assert.deepEqual(current.audits(), [])
    assert.deepEqual(current.tempTables(), before)
  } finally { if (timer) clearImmediate(timer) }
})

for (const symlink of [false, true]) it(`propagates native discovery INSERT failure without importing or swallowing it (${symlink ? 'symlink flush' : 'ordinary flush'})`, async () => {
  const current = setup(Array.from({ length: 255 }, (_, index) => `a${String(index).padStart(3, '0')}.mp4`))
  const last = path.join(media, 'z-last.mp4')
  if (symlink) fs.symlinkSync(path.join(media, 'a000.mp4'), last)
  else fs.writeFileSync(last, 'last video')
  const before = current.tempTables()
  await assert.rejects(scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary',
    readDirectory: async dir => {
      const table = current.tempTables().find(row => !before.some(old => old.name === row.name))!
      current.db.exec(`CREATE TEMP TRIGGER fail_inventory BEFORE INSERT ON "${table.name}"
        WHEN NEW.ordinal=256 BEGIN SELECT RAISE(ABORT,'inventory insertion fault'); END`)
      return current.options.readDirectory!(dir)
    }
  }), error => {
    assert.ok(error instanceof ScanFoldersFailure)
    assert.match(error.message, /inventory insertion fault/)
    assert.equal(error.partialResult.scannedFiles, 0)
    assert.equal(error.partialResult.imported, 0); assert.equal(error.partialResult.failed, 0)
    return true
  })
  assert.deepEqual(current.audits(), [])
  assert.deepEqual(current.db.prepare('SELECT id FROM videos').all(), [])
  assert.deepEqual(current.tempTables(), before)
})

it('propagates a normal dispose failure with committed partial counts and retries cleanup in finally', async context => {
  const current = setup(['ABC-001.mp4'])
  const before = current.tempTables(), original = current.db.exec
  let drops = 0
  context.mock.method(current.db, 'exec', (sql: string) => {
    if (/DROP TABLE IF EXISTS temp.scan_file_inventory_/.test(sql) && ++drops === 1) throw new Error('inventory dispose fault')
    return original.call(current.db, sql)
  })
  await assert.rejects(scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary' }), error => {
    assert.ok(error instanceof ScanFoldersFailure)
    assert.match(error.message, /inventory dispose fault/)
    assert.equal(error.partialResult.imported, 1); assert.equal(error.partialResult.scannedFiles, 1)
    return true
  })
  assert.equal(drops, 2)
  assert.equal(current.audits().length, 1)
  assert.deepEqual(current.tempTables(), before)
})

it('preserves the triggering discovery error if final disposal also fails', async context => {
  const current = setup(['ABC-001.mp4'])
  const before = current.tempTables(), original = current.db.exec
  let tableName = '', drops = 0
  context.mock.method(current.db, 'exec', (sql: string) => {
    if (/DROP TABLE IF EXISTS temp.scan_file_inventory_/.test(sql)) { drops++; throw new Error('secondary dispose failure') }
    return original.call(current.db, sql)
  })
  try {
    await assert.rejects(scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary',
      readDirectory: async () => {
        tableName = current.tempTables().find(row => !before.some(old => old.name === row.name))!.name
        throw new Error('original discovery failure')
      }
    }), error => {
      assert.ok(error instanceof ScanFoldersFailure)
      assert.match(error.message, /original discovery failure/)
      assert.doesNotMatch(error.message, /secondary dispose failure/)
      assert.equal(error.partialResult.imported, 0)
      return true
    })
    assert.equal(drops, 1)
    assert.deepEqual(current.audits(), [])
  } finally {
    context.mock.restoreAll()
    if (tableName) original.call(current.db, `DROP TABLE IF EXISTS temp."${tableName}"`)
  }
  assert.deepEqual(current.tempTables(), before)
})

it('releases TEMP before NFO tail while retaining all paged directory identities and anchors', async () => {
  const current = setup(Array.from({ length: 260 }, (_, index) => `ABC-001-CD${index + 1}.mp4`))
  const before = current.tempTables()
  let appliedAnchors = 0, identityCount = 0, tablesAtApply: { name: string }[] | undefined
  const result = await scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary', autoImportLocalNfo: true,
    localNfoService: {
      inspectIdentity: () => ({ status: 'found', code: 'ABC-001', warnings: [] }),
      apply: async (_id, _code, anchors) => {
        appliedAnchors = anchors.length
        identityCount = Reflect.get(anchors[0].directoryVideoCodes, 'count')
        tablesAtApply = current.tempTables()
        return { disposition: 'imported', warnings: [] }
      }
    }
  })
  assert.equal(result.scannedFiles, 260); assert.equal(result.imported, 260)
  assert.equal(appliedAnchors, 260); assert.equal(identityCount, 260)
  assert.deepEqual(tablesAtApply?.filter(row => !row.name.startsWith('scan_nfo_workset_')), before)
  assert.ok(tablesAtApply?.some(row => row.name.startsWith('scan_nfo_workset_')), 'NFO state remains live until its tail completes')
  assert.equal(current.audits().length, 260)
  assert.deepEqual(current.tempTables(), before)
})

it('disposes TEMP after targeted preflight validation failure', async () => {
  const current = setup(['r1/ABC-001.mp4', 'r2/DEF-002.mp4'], true)
  const before = current.tempTables()
  await assert.rejects(scanFolders({ ...current.request, filePaths: [path.join(media, 'r1/ABC-001.mp4')] }, undefined,
    { ...current.options, resultMode: 'summary' }), /唯一根目录/)
  assert.deepEqual(current.tempTables(), before)
  assert.deepEqual(current.audits(), [])
})

it('disposes an empty TEMP inventory when already cancelled without reading directories', async () => {
  const current = setup(['ABC-001.mp4']), controller = new AbortController()
  controller.abort()
  const before = current.tempTables()
  let reads = 0
  const result = await scanFolders(current.request, undefined, { ...current.options, resultMode: 'summary', signal: controller.signal,
    readDirectory: async () => { reads++; return [] }
  })
  assert.equal(result.cancelled, true); assert.equal(result.scannedFiles, 0)
  assert.equal(reads, 0)
  assert.deepEqual(current.tempTables(), before)
  assert.deepEqual(current.audits(), [])
})
