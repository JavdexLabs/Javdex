import { afterEach, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, initDatabaseAtPath } from '@library/db/database'
import { createMediaLibrary } from '@library/db/mediaLibraryRepo'
import { createDefaultLocalNfoSourceAdapter, type LocalNfoAnchor, type LocalNfoIdentityInspection,
  type MetadataCandidateBatch } from '../metadata-sources'
import { sameLogicalCode } from '../nfo/nfoSidecarLocator'
import type { LocalNfoScanService } from '../services/localNfoScanService'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import { scanFolders } from './scanner'

let directory: string, media: string, previousUserData: string | undefined
beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-nfo-directory-'))
  media = path.join(directory, 'media')
  fs.mkdirSync(media)
  process.env.JAVDEX_TEST_USER_DATA = directory
})
afterEach(() => {
  closeDatabase()
  resetSettingsCacheForTests()
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  fs.rmSync(directory, { recursive: true, force: true })
})
function fixture(names: string[]) {
  for (const name of names) {
    const file = path.join(media, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'synthetic video')
  }
  const db = initDatabaseAtPath(path.join(directory, 'catalog.db'))
  const library = createMediaLibrary({ name: 'Directory identity', roots: [{ path: media }] })
  return { db, request: { libraryId: library.id, runId: 'directory-scan', roots: library.roots } }
}
const scanOptions = {
  autoImportLocalNfo: true, autoMergeSameCodeResources: true,
  minImportDurationSeconds: 1, readDurationSeconds: async () => 120,
  readDirectory: async (dir: string) => (await fs.promises.readdir(dir, { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

it('passes one bounded directory identity for 120 same-code parts, retaining it after other directory anchors', async () => {
  const current = fixture([
    ...Array.from({ length: 120 }, (_, index) => `a-parts/ABC-001-CD${index + 1}.mp4`),
    'z-other/XYZ-002.mp4'
  ])
  const observed: LocalNfoAnchor[] = []
  let firstSnapshot: string | undefined
  const service: LocalNfoScanService = {
    inspectIdentity: anchor => {
      if (observed.length === 0) firstSnapshot = JSON.stringify(anchor.directoryVideoCodes)
      observed.push(anchor)
      return { status: 'missing', code: null, warnings: [] }
    },
    apply: async () => ({ disposition: 'none', warnings: [] })
  }
  const result = await scanFolders(current.request, undefined, { ...scanOptions, localNfoService: service })
  assert.equal(result.scannedFiles, 121)
  assert.equal(observed.length, 121)
  const parts = observed.filter(anchor => path.basename(path.dirname(anchor.anchorPath)) === 'a-parts')
  const first = parts[0].directoryVideoCodes
  assert.equal(Array.isArray(first), false, 'scanner must supply a summary rather than a per-file code array')
  assert.equal(Reflect.get(first, 'kind'), 'summary')
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 256, 'directory context does not grow with part count')
  assert.ok(parts.every(anchor => anchor.directoryVideoCodes === first), 'anchors share the completed immutable directory context')
  assert.equal(sameLogicalCode(first), true)
  assert.equal(sameLogicalCode(observed.at(-1)!.directoryVideoCodes), true)
  assert.notEqual(first, observed.at(-1)!.directoryVideoCodes)
  assert.equal(sameLogicalCode(first), true, 'later directories must not mutate retained anchors')
  assert.equal(JSON.stringify(first), firstSnapshot, 'retained context remains unchanged after every later anchor')
})

// Compare visible candidate data, not newly issued opaque file capabilities.
function candidateData(batch: MetadataCandidateBatch) {
  return { warnings: batch.warnings, candidates: batch.candidates.map(candidate => ({
    result: candidate.result,
    assets: candidate.assets.map(asset => asset.kind === 'managed-root-file'
      ? { kind: asset.kind, field: asset.field, position: asset.position, filename: asset.filename }
      : asset)
  })) }
}

for (const targeted of [false, true]) it(`keeps real movie.nfo adoption and generic asset ownership with ${targeted ? 'targeted sibling' : 'full directory'} identities`, async () => {
  const cases = [
    { dir: 'parts', names: ['ABC-001-CD1.mp4', 'ABC-001-CD2.mp4'], codes: ['ABC-001', 'ABC-001'], code: 'ABC-001', single: true },
    { dir: 'mixed', names: ['DEF-002.mp4', 'GHI-003.mp4'], codes: ['DEF-002', 'GHI-003'], code: 'DEF-002', single: false },
    { dir: 'unknown', names: ['JKL-004.mp4', 'unknown.mp4'], codes: ['JKL-004', null], code: 'JKL-004', single: false },
    { dir: 'only-unknown', names: ['unknown.mp4'], codes: [null], code: 'SOLO-005', single: true }
  ]
  const current = fixture(cases.flatMap(item => item.names.map(name => `${item.dir}/${name}`)))
  for (const item of cases) {
    fs.writeFileSync(path.join(media, item.dir, 'movie.nfo'), `<movie><num>${item.code}</num><title>Local ${item.code}</title></movie>`)
    fs.writeFileSync(path.join(media, item.dir, 'poster.jpg'), 'synthetic poster')
    fs.writeFileSync(path.join(media, item.dir, 'fanart.jpg'), 'synthetic fanart')
  }
  const source = createDefaultLocalNfoSourceAdapter()
  const observed = new Map<string, { anchor: LocalNfoAnchor; inspection: LocalNfoIdentityInspection }>()
  const applied: string[] = []
  const service: LocalNfoScanService = {
    inspectIdentity: anchor => {
      const inspection = source.inspectIdentity(anchor)
      observed.set(anchor.anchorPath, { anchor, inspection })
      return inspection
    },
    apply: async (videoId, code, anchors) => {
      // Use the real asset collector at the scanner's apply boundary as well.
      const batch = await source.collectFromAnchors({ target: { kind: 'video', videoId, code }, fields: ['title', 'cover', 'samples'] }, anchors)
      if (batch.candidates.length) applied.push(code)
      return { disposition: 'none', warnings: batch.warnings }
    }
  }
  const targets = cases.map(item => path.join(media, item.dir, item.names[0]))
  await scanFolders({ ...current.request, ...(targeted ? { filePaths: targets } : {}) }, undefined, { ...scanOptions, localNfoService: service })
  assert.equal(observed.size, targeted ? cases.length : 7)
  assert.ok(applied.includes('ABC-001')); assert.ok(applied.includes('SOLO-005'))
  assert.equal(applied.includes('DEF-002'), false); assert.equal(applied.includes('JKL-004'), false)
  for (const item of cases) {
    const { anchor, inspection } = observed.get(path.join(media, item.dir, item.names[0]))!
    assert.equal(Array.isArray(anchor.directoryVideoCodes), false)
    assert.equal(sameLogicalCode(anchor.directoryVideoCodes), item.single)
    assert.equal(sameLogicalCode(item.codes), item.single, 'legacy arrays retain the same semantics')
    assert.equal(inspection.status, item.single ? 'found' : 'warning')
    assert.equal(inspection.code, item.single ? item.code : null)
    const request = { target: { kind: 'video' as const, videoId: 1, code: item.code }, fields: ['title', 'cover', 'samples'] as const }
    const actual = await source.collectFromAnchors({ ...request, fields: [...request.fields] }, [anchor])
    const legacy = await source.collectFromAnchors({ ...request, fields: [...request.fields] }, [{ ...anchor, directoryVideoCodes: item.codes }])
    assert.deepEqual(candidateData(actual), candidateData(legacy))
    if (item.single) {
      assert.deepEqual(actual.candidates[0].assets.map(asset => asset.kind === 'managed-root-file' ? asset.filename : null), ['poster.jpg', 'fanart.jpg'])
    } else {
      assert.equal(actual.candidates.length, 0, 'ambiguous movie.nfo must not be adopted')
      // An exact sidecar is valid in a mixed directory but cannot own generic images.
      const stem = path.basename(anchor.anchorPath, '.mp4')
      fs.writeFileSync(path.join(media, item.dir, `${stem}.nfo`), `<movie><num>${item.code}</num><title>Exact</title></movie>`)
      const exactAnchor = { ...anchor, directorySidecars: undefined }
      const exact = await source.collectFromAnchors({ ...request, fields: [...request.fields] }, [exactAnchor])
      const exactLegacy = await source.collectFromAnchors({ ...request, fields: [...request.fields] }, [{ ...exactAnchor, directoryVideoCodes: item.codes }])
      assert.deepEqual(candidateData(exact), candidateData(exactLegacy))
      assert.equal(exact.candidates.length, 1)
      assert.deepEqual(exact.candidates[0].assets, [], 'generic poster/fanart must not leak between directory identities')
    }
  }
})

for (const targeted of [false, true]) it(`does not invoke NFO services when disabled (${targeted ? 'targeted' : 'full'})`, async () => {
  const current = fixture(['ABC-001.mp4', 'ABC-001-CD2.mp4'])
  fs.writeFileSync(path.join(media, 'movie.nfo'), '<movie><num>ABC-001</num></movie>')
  let inspections = 0, applies = 0, reads = 0
  const result = await scanFolders({ ...current.request, ...(targeted ? { filePaths: [path.join(media, 'ABC-001.mp4')] } : {}) }, undefined, {
    ...scanOptions, autoImportLocalNfo: false,
    readDirectory: async dir => { reads++; return scanOptions.readDirectory(dir) },
    localNfoService: {
      inspectIdentity: () => { inspections++; throw new Error('disabled inspect') },
      apply: async () => { applies++; throw new Error('disabled apply') }
    }
  })
  assert.equal(result.scannedFiles, targeted ? 1 : 2)
  assert.equal(inspections, 0); assert.equal(applies, 0)
  if (targeted) assert.equal(reads, 0, 'explicit targets need no sibling/sidecar directory index when NFO is disabled')
  else assert.equal(reads, 1, 'full discovery still needs one directory read')
})

it('counts actual siblings once for repeated targeted unknown paths without making movie.nfo ambiguous', async () => {
  const current = fixture(['unknown.mp4'])
  fs.writeFileSync(path.join(media, 'movie.nfo'), '<movie><num>SINGLE-001</num><title>Singleton unknown</title></movie>')
  const source = createDefaultLocalNfoSourceAdapter()
  const observed: Array<{ anchor: LocalNfoAnchor; inspection: LocalNfoIdentityInspection }> = []
  let adopted = false
  const filePath = path.join(media, 'unknown.mp4')
  const result = await scanFolders({ ...current.request, filePaths: [filePath, filePath] }, undefined, {
    ...scanOptions,
    localNfoService: {
      inspectIdentity: anchor => {
        const inspection = source.inspectIdentity(anchor)
        observed.push({ anchor, inspection })
        return inspection
      },
      apply: async (videoId, code, anchors) => {
        const batch = await source.collectFromAnchors({ target: { kind: 'video', videoId, code }, fields: ['title'] }, anchors)
        adopted = batch.candidates.some(candidate => candidate.result.title === 'Singleton unknown')
        return { disposition: 'none', warnings: batch.warnings }
      }
    }
  })
  assert.equal(result.scannedFiles, 2, 'requested duplicates preserve the existing scan-attempt contract')
  assert.equal(observed.length, 2, 'both requested targets are preflighted before imports')
  const summary = observed[0].anchor.directoryVideoCodes
  assert.equal(Array.isArray(summary), false)
  assert.equal(Reflect.get(summary, 'kind'), 'summary')
  assert.equal(Reflect.get(summary, 'count'), 1, 'identity counts directory siblings rather than requested targets')
  assert.equal(sameLogicalCode(summary), true)
  for (const { anchor, inspection } of observed) {
    assert.equal(anchor.directoryVideoCodes, summary)
    assert.equal(inspection.status, 'found')
    assert.equal(inspection.code, 'SINGLE-001')
  }
  assert.equal(adopted, true, 'retained singleton context still adopts movie.nfo at the apply tail')
})

it('honors a scheduled cancellation at the directory identity yield before NFO preflight or import', async () => {
  const current = fixture(['ABC-001-CD1.mp4', 'ABC-001-CD2.mp4', 'XYZ-002.mp4'])
  const controller = new AbortController()
  let timer: ReturnType<typeof setImmediate> | undefined
  let directoryRead = false, abortDelivered = false, inspections = 0, applies = 0, probes = 0, auditEntries = 0
  try {
    const result = await scanFolders(current.request, undefined, {
      ...scanOptions, signal: controller.signal, yieldEvery: 1,
      readDirectory: async dir => {
        const entries = await scanOptions.readDirectory(dir)
        directoryRead = true
        // Discovery resumes through microtasks; this fires at the identity loop's first yield.
        timer = setImmediate(() => { abortDelivered = true; controller.abort() })
        return entries
      },
      readDurationSeconds: async () => { probes++; return 120 },
      onFileResult: () => { auditEntries++ },
      localNfoService: {
        inspectIdentity: () => { inspections++; return { status: 'missing', code: null, warnings: [] } },
        apply: async () => { applies++; return { disposition: 'none', warnings: [] } }
      }
    })
    assert.equal(directoryRead, true)
    assert.equal(abortDelivered, true)
    assert.equal(result.cancelled, true)
    assert.equal(result.scannedFiles, 0)
    assert.equal(result.imported, 0)
    assert.equal(inspections, 0); assert.equal(applies, 0)
    assert.equal(probes, 0); assert.equal(auditEntries, 0)
    assert.deepEqual(current.db.prepare('SELECT id FROM videos').all(), [])
    assert.deepEqual(current.db.prepare('SELECT id FROM video_resources').all(), [])
  } finally {
    if (timer) clearImmediate(timer)
  }
})
