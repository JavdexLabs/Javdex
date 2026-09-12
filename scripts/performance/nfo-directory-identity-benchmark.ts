/** Synthetic identity predicate probe, excluding filesystem and NFO parsing. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { normalizeVideoCode } from '../../packages/contracts/src/videoCode'
import { sameLogicalCode } from '../../packages/library/src/nfo/nfoSidecarLocator'

// Frozen pre-DA predicate, retained only as the comparison oracle.
function legacySameLogicalCode(values: readonly (string | null)[]): boolean {
  if (values.length === 1) return true
  const normalized = values.map(value => {
    if (!value) return null
    try { return normalizeVideoCode(value) } catch { return null }
  })
  return normalized.length > 0 && normalized.every(value => value && value === normalized[0])
}

it('measures one directory identity build and one eligibility check per anchor', async () => {
  const summaryModule = process.env.JAVDEX_NFO_SUMMARY_PROBE === '1'
    ? await import('../../packages/library/src/nfo/directoryVideoIdentity') : null
  const results: unknown[] = []
  for (const count of [1000, 5000]) {
    const codes = Array.from({ length: count }, () => 'IPX-001')
    for (const mode of summaryModule ? ['legacy-array', 'summary'] : ['legacy-array']) {
      const samples: number[] = []
      for (let sample = -1; sample < 3; sample++) {
        const start = performance.now()
        const identity = mode === 'summary' ? summaryModule!.summarizeDirectoryVideoCodes(codes) : codes
        let accepted = 0
        for (let index = 0; index < count; index++) {
          if (mode === 'summary' ? sameLogicalCode(identity) : legacySameLogicalCode(codes)) accepted++
        }
        const elapsed = performance.now() - start
        assert.equal(accepted, count)
        if (sample >= 0) samples.push(elapsed)
      }
      results.push({ count, mode, samplesMs: samples })
    }
  }
  console.log(JSON.stringify({ results, notes: [
    'Frozen pre-DA array predicate versus current summary builder and current sameLogicalCode consumer.',
    'One warmup and three samples; each sample includes summary construction and N eligibility checks for N same-code anchors.',
    'Raw code fixture is allocated before timing for both modes; no filesystem, parseCode, NFO parsing/application, audit or IPC measured.',
    'Not a whole-scanner RSS/throughput/p95 or Windows/HDD acceptance test.'
  ] }, null, 2))
})
