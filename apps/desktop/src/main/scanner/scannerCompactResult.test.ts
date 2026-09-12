import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ScanCompletionResult, ScanResult } from '@shared/libraryTypes'
import { getUnrecognizedFileCount, toScanCompletionResult } from '@shared/scanResult'
import { closeDatabase, initDatabaseAtPath } from '@library/db/database'
import { createMediaLibrary } from '@library/db/mediaLibraryRepo'
import { beginLibraryScanRun } from '@library/db/libraryScanRepo'
import { createScanAuditWriter } from '@library/db/scanAuditWriter'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import { scanFolders, ScanFoldersFailure, type ScanOptions } from './scanner'

let directory: string, media: string, previous: string | undefined, sequence = 0
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-compact-scan-'))
  media = path.join(directory, 'media'); fs.mkdirSync(media)
  previous = process.env.JAVDEX_TEST_USER_DATA; process.env.JAVDEX_TEST_USER_DATA = directory
})
afterEach(() => {
  closeDatabase(); resetSettingsCacheForTests()
  if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previous
  fs.rmSync(directory, { recursive: true, force: true })
})
function setup(names: string[]) {
  closeDatabase(); resetSettingsCacheForTests()
  for (const name of names) fs.writeFileSync(path.join(media, name), name.endsWith('.strm') ? 'https://example.test/media.mp4' : 'video')
  const db = initDatabaseAtPath(path.join(directory, `catalog-${++sequence}.db`))
  const library = createMediaLibrary({ name: 'Compact', roots: [{ path: media }] })
  const request = { libraryId: library.id, runId: 'compact', roots: library.roots }
  beginLibraryScanRun({ ...request, configRevision: 1, trigger: 'manual', startedAt: 'start' })
  const writer = createScanAuditWriter(db, request)
  writer.start({ schemaVersion: 2, libraryId: library.id, runId: request.runId, configRevision: 1,
    trigger: 'manual', status: 'success', startedAt: 'start', finishedAt: 'pending' })
  const sink: NonNullable<ScanOptions['auditSink']> = {
    recordFile: (entry) => writer.writeBatch('files', [entry]),
    readFileNfo: (filePath) => writer.readFileNfo(filePath), patchNfo: (filePath, nfo) => writer.patchNfo(filePath, nfo)
  }
  const options = { auditSink: sink, yieldEvery: 1, minImportDurationSeconds: 1,
    autoImportLocalNfo: false, autoMergeSameCodeResources: true,
    readDurationSeconds: async () => 120,
    readDirectory: async (dir: string) => (await fs.promises.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)) }
  return { db, request, options }
}
function assertCompact(result: ScanCompletionResult) {
  assert.equal(Object.hasOwn(result, 'newCodes'), false)
  assert.equal(Object.hasOwn(result, 'unrecognizedFiles'), false)
  assert.doesNotMatch(JSON.stringify(result), /"newCodes"|"unrecognizedFiles"/)
}

it('counts repeated unknown attempts independently of the single upserted audit row', async () => {
  const filePath = path.join(media, 'unknown.mp4')
  const detailed = setup(['unknown.mp4'])
  const full = await scanFolders({ ...detailed.request, filePaths: [filePath, filePath] }, undefined,
    { ...detailed.options, resultMode: 'detailed' })
  assert.equal(full.scannedFiles, 2)
  assert.equal(full.failed, 2)
  assert.deepEqual(full.unrecognizedFiles, [filePath, filePath])
  const summary = setup(['unknown.mp4'])
  const compact = await scanFolders({ ...summary.request, filePaths: [filePath, filePath] }, undefined,
    { ...summary.options, resultMode: 'summary' })
  assert.equal(compact.scannedFiles, 2)
  assert.equal(compact.failed, 2)
  assert.equal(compact.unrecognizedCount, 2)
  assert.deepEqual(compact, toScanCompletionResult(full))
  assertCompact(compact)
  assert.deepEqual(summary.db.prepare("SELECT COUNT(*) AS count FROM library_scan_audit_entries WHERE section='files'").get(), { count: 1 })
})

it('matches detailed default counts and imports while summary omits per-file arrays', async () => {
  const names = ['CODE-001.mp4', 'CODE-002.strm', 'unknown.mp4', 'unknown.strm']
  const detailed = setup(names)
  const full: ScanResult = await scanFolders(detailed.request, undefined, detailed.options)
  assert.equal(full.imported, 2)
  assert.equal(full.newCodes.length, 2)
  assert.equal(full.unrecognizedFiles.length, 2)
  const summary = setup(names)
  const compact: ScanCompletionResult = await scanFolders(summary.request, undefined, { ...summary.options, resultMode: 'summary' })
  assert.deepEqual(compact, toScanCompletionResult(full))
  assert.equal(compact.unrecognizedCount, 2)
  assertCompact(compact)
})

for (const resultMode of ['detailed', 'summary'] as const) {
  for (const extension of ['mp4', 'strm']) {
    it(`${resultMode} ${extension} fatal partial counts include only successfully persisted unknown files`, async () => {
      const fixture = setup([`alpha.${extension}`, `beta.${extension}`])
      fixture.db.exec(`CREATE TRIGGER fail_unknown_audit BEFORE INSERT ON library_scan_audit_entries
        WHEN NEW.section='files' AND NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'unknown audit failed'); END`)
      await assert.rejects(scanFolders(fixture.request, undefined, { ...fixture.options, resultMode }), (error) => {
        assert.ok(error instanceof ScanFoldersFailure)
        assert.ok(error.cause instanceof Error)
        assert.match(error.cause.message, /unknown audit failed/)
        assert.equal(error.partialResult.scannedFiles, 2)
        assert.equal(error.partialResult.failed, 1)
        assert.equal(getUnrecognizedFileCount(error.partialResult), 1)
        if (resultMode === 'summary') assertCompact(error.partialResult as ScanCompletionResult)
        else assert.equal((error.partialResult as ScanResult).unrecognizedFiles.length, 1)
        return true
      })
      assert.deepEqual(fixture.db.prepare("SELECT COUNT(*) AS count FROM library_scan_audit_entries WHERE section='files'").get(), { count: 1 })
    })
  }
}

it('preserves committed import counts in compact fatal partial results', async () => {
  const fixture = setup(['CODE-001.mp4', 'CODE-002.mp4'])
  fixture.db.exec(`CREATE TRIGGER fail_import_audit BEFORE INSERT ON library_scan_audit_entries
    WHEN NEW.section='files' AND NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'import audit failed'); END`)
  await assert.rejects(scanFolders(fixture.request, undefined, { ...fixture.options, resultMode: 'summary' }), (error) => {
    assert.ok(error instanceof ScanFoldersFailure)
    assert.equal(error.partialResult.imported, 1)
    assert.equal(error.partialResult.scannedFiles, 2)
    assertCompact(error.partialResult as ScanCompletionResult)
    return true
  })
})

it('returns compact cancellation with committed counts and rejects summary without a sink before work', async () => {
  const fixture = setup(['alpha.mp4', 'beta.mp4'])
  const controller = new AbortController()
  const result = await scanFolders(fixture.request, () => controller.abort(), {
    ...fixture.options, resultMode: 'summary', signal: controller.signal
  })
  assert.equal(result.cancelled, true)
  assert.equal(result.unrecognizedCount, 1)
  assertCompact(result)
  await assert.rejects(scanFolders(fixture.request, undefined, {
    resultMode: 'summary', readDirectory: async () => { throw new Error('must not read') }
  }), /require an audit sink/)
})

it('allowlists completion fields even when a summary-shaped input carries detailed properties', async () => {
  const fixture = setup(['unknown.mp4'])
  const result = await scanFolders(fixture.request, undefined, { ...fixture.options, resultMode: 'summary' })
  const decorated = { ...result, newCodes: ['secret'], unrecognizedFiles: ['/secret'], extra: 'secret' }
  const converted = toScanCompletionResult(decorated)
  assertCompact(converted)
  assert.equal(Object.hasOwn(converted, 'extra'), false)
  assert.equal(converted.unrecognizedCount, result.unrecognizedCount)
  assert.equal(converted.offlineFolders, result.offlineFolders)
  assert.equal(converted.strmFailures, result.strmFailures)
})


it('keeps serialized completion size independent of many actual unknown paths apart from counter digits', async (t) => {
  const names = Array.from({ length: 300 }, (_, i) =>
    `unknown-${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + i % 26)}.mp4`)
  const small = setup([names[0]])
  const one = await scanFolders(small.request, undefined, { ...small.options, resultMode: 'summary' })
  const large = setup(names)
  const many = await scanFolders(large.request, undefined, { ...large.options, resultMode: 'summary' })
  assert.equal(one.unrecognizedCount, 1)
  assert.equal(many.unrecognizedCount, 300)
  assertCompact(many)
  assert.deepEqual({ ...many, scannedFiles: 1, failed: 1, unrecognizedCount: 1 }, one)
  const oneBytes = Buffer.byteLength(JSON.stringify(one)), manyBytes = Buffer.byteLength(JSON.stringify(many))
  assert.equal(manyBytes - oneBytes, 6, 'only three numeric counters grow from one to three digits')
  assert.ok(manyBytes < 1024)
  t.diagnostic(`Completion JSON: 1 unknown=${oneBytes} bytes; 300 unknown=${manyBytes} bytes (not a whole-scan RSS measure)`)
})
