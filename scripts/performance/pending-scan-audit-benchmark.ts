/**
 * Standalone synthetic fixture; never opens a user database or media file.
 * Run when other tests/benchmarks are idle:
 * node scripts/run-electron-tests.mjs scripts/performance/pending-scan-audit-benchmark.ts
 * JSON is emitted to stdout inside the test runner output. Setup, assertions and
 * output serialization are excluded from timed intervals.
 */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { LibraryScanPendingGroupAuditEntry } from '../../packages/contracts/src/libraryTypes'
import { initDatabaseAtPath, closeDatabase } from '../../apps/desktop/src/main/db/database'
import { createMediaLibrary } from '../../apps/desktop/src/main/db/mediaLibraryRepo'
import { listPendingScanGroups } from '../../apps/desktop/src/main/db/pendingScanRepo'
import { readPendingScanAuditEntries } from '../../apps/desktop/src/main/db/pendingScanAuditRepo'

type Method = 'legacyFullDtoFilterMap' | 'targetedAuditEntries'
interface Measurement {
  warmupMs: number
  samplesMs: number[]
  medianMs: number
  outputRows: number
  outputJsonBytes: number
}

it('compares pending scan audit summaries with full pending DTO hydration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pending-scan-audit-benchmark-'))
  const results: Array<{
    resources: number
    groups: number
    resourcesPerGroup: number
    scenario: 'tenGroups' | 'allGroups'
    selectedGroups: number
    pendingPaths: number
    databaseBytes: number
    oraclePassed: boolean
    methods: Record<Method, Measurement>
  }> = []
  try {
    for (const resourceCount of [10_000, 50_000]) {
      const databasePath = path.join(root, `${resourceCount}.sqlite`)
      const db = initDatabaseAtPath(databasePath)
      try {
        const mediaPath = path.join(root, `media-${resourceCount}`)
        fs.mkdirSync(mediaPath)
        const library = createMediaLibrary({ name: `Synthetic pending ${resourceCount}`, roots: [{ path: mediaPath }] })
        const groupCount = resourceCount / 10
        const targetLocator = 'https://example.invalid/'.padEnd(512, 'x')
        const displayName = 'd'.repeat(512)
        const group = db.prepare('INSERT INTO pending_scan_groups(id,library_id,normalized_code,updated_at) VALUES(?,?,?,?)')
        const resource = db.prepare(`INSERT INTO pending_scan_resources
          (library_id,group_id,root_id,file_path,normalized_path,source_kind,target_kind,target_locator,display_name)
          VALUES(?,?,?,?,?,'strm','web',?,?)`)
        // Global exact-path set: every group contributes three matching resources.
        // Keep this identical for sparse and all-group queries, like the old coordinator.
        const pendingPaths = new Set<string>()
        db.transaction(() => {
          for (let id = 1; id <= groupCount; id++) {
            // Deliberately different from ID order, with ties resolved by ID.
            group.run(id, library.id, `GROUP-${id}`, `2026-01-0${id % 7 + 1}`)
            for (let item = 0; item < 10; item++) {
              const filePath = path.join(mediaPath, `Group-${id}-${item}.strm`)
              resource.run(library.id, id, library.roots[0].id, filePath, filePath, targetLocator, displayName)
              if (item === 0 || item === 3 || item === 9) pendingPaths.add(filePath)
            }
          }
        })()
        pendingPaths.add(path.join(mediaPath, 'group-1-1.strm')) // case mismatch must not count
        pendingPaths.add(path.join(mediaPath, 'not-in-database.strm'))
        db.exec('ANALYZE; PRAGMA wal_checkpoint(TRUNCATE)')
        const widths = db.prepare(`SELECT count(*) AS resources,
          min(length(target_locator)) AS targetMin, max(length(target_locator)) AS targetMax,
          min(length(display_name)) AS displayMin, max(length(display_name)) AS displayMax
          FROM pending_scan_resources WHERE library_id=?`).get(library.id)
        assert.deepEqual(widths, { resources: resourceCount, targetMin: 512, targetMax: 512, displayMin: 512, displayMax: 512 })
        const databaseBytes = fs.statSync(databasePath).size

        for (const scenario of ['tenGroups', 'allGroups'] as const) {
          const ids = scenario === 'tenGroups'
            ? Array.from({ length: 10 }, (_, index) => 1 + Math.floor(index * (groupCount - 1) / 9))
            : Array.from({ length: groupCount }, (_, index) => index + 1)
          const groupIds = new Set([...ids].reverse())
          const readers: Record<Method, () => LibraryScanPendingGroupAuditEntry[]> = {
            legacyFullDtoFilterMap: () => listPendingScanGroups(library.id)
              .filter(entry => groupIds.has(entry.id))
              .map(entry => ({
                groupId: entry.id,
                normalizedCode: entry.normalizedCode,
                resourceCount: entry.resources.filter(item => pendingPaths.has(item.filePath)).length
              })),
            targetedAuditEntries: () => readPendingScanAuditEntries(library.id, groupIds, pendingPaths)
          }
          // Untimed old implementation oracle plus independently specified counts/order.
          const oracle = readers.legacyFullDtoFilterMap()
          assert.deepEqual(oracle, [...ids].sort((a, b) => a % 7 - b % 7 || a - b)
            .map(id => ({ groupId: id, normalizedCode: `GROUP-${id}`, resourceCount: 3 })))
          const methods: Record<Method, Measurement> = {
            legacyFullDtoFilterMap: { warmupMs: 0, samplesMs: [], medianMs: 0, outputRows: 0, outputJsonBytes: 0 },
            targetedAuditEntries: { warmupMs: 0, samplesMs: [], medianMs: 0, outputRows: 0, outputJsonBytes: 0 }
          }
          const measure = (method: Method, warmup: boolean): void => {
            const start = performance.now()
            const value = readers[method]()
            const elapsedMs = performance.now() - start
            // Do not include correctness checks or JSON serialization in repo timing.
            assert.deepEqual(value, oracle, `${resourceCount}/${scenario}/${method}`)
            const jsonBytes = Buffer.byteLength(JSON.stringify(value))
            const measurement = methods[method]
            if (warmup) measurement.warmupMs = elapsedMs
            else measurement.samplesMs.push(elapsedMs)
            measurement.outputRows = value.length
            measurement.outputJsonBytes = jsonBytes
          }
          for (const method of ['legacyFullDtoFilterMap', 'targetedAuditEntries'] as const) measure(method, true)
          for (let sample = 0; sample < 3; sample++) {
            const order: Method[] = sample % 2 === 0
              ? ['legacyFullDtoFilterMap', 'targetedAuditEntries']
              : ['targetedAuditEntries', 'legacyFullDtoFilterMap']
            for (const method of order) measure(method, false)
          }
          for (const measurement of Object.values(methods)) {
            assert.equal(measurement.samplesMs.length, 3)
            measurement.medianMs = [...measurement.samplesMs].sort((a, b) => a - b)[1]
          }
          results.push({ resources: resourceCount, groups: groupCount, resourcesPerGroup: 10,
            scenario, selectedGroups: groupIds.size, pendingPaths: pendingPaths.size,
            databaseBytes, oraclePassed: true, methods })
        }
      } finally {
        closeDatabase()
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  console.log(JSON.stringify({
    benchmark: 'pending-scan-audit',
    environment: { platform: process.platform, arch: process.arch, node: process.version, electron: process.versions.electron, sqlite: process.versions.sqlite },
    warmupRunsPerMethod: 1,
    hotSamplesPerMethod: 3,
    results,
    limitations: [
      'Synthetic temporary SQLite files only; 10 resources per group, ASCII target_locator/display_name each exactly 512 characters. No user database or media files.',
      'Untimed legacy oracle reads precede one explicit warmup per method. Three hot rounds alternate method order; warmup and timings are not cold-cache measurements.',
      'Timing includes each repository call and legacy filter/map, including DTO materialization, path checks and the new repository transaction. Fixture setup, ANALYZE, assertions and JSON serialization are outside timing.',
      'Output JSON bytes describe final audit summaries only, not transient full DTO allocations. Peak memory, event-loop delay, IPC, filesystem scan/reveal and complete coordinator runtime are not measured.',
      'A single synthetic library, global pending path set, 1k/5k groups and 10k/50k resources do not establish Windows HDD or production performance. Three samples do not support p95 claims.',
      'Selecting all groups still visits every group/resource path and builds the full audit summary array. This does not claim constant memory or constant total runtime.'
    ]
  }, null, 2))
})
