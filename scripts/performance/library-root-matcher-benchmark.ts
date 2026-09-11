/** Synthetic strings only. Opt in to 100k files with JAVDEX_ROOT_MATCH_FILES=100000. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { isPathUnderRoot } from '../../src/main/scanner/libraryPathUtils'
import { createLibraryRootMatcher } from '../../src/main/scanner/libraryRootMatcher'

type Root = { id: number; path: string; realPath: string | null }
type Match = (filePath: string) => Root | undefined

function summarize(samples: number[]): { samplesMs: number[]; medianMs: number } {
  return { samplesMs: samples, medianMs: [...samples].sort((a, b) => a - b)[1] }
}

it('compares root matching against ordered find by object identity', () => {
  const rawCount = process.env.JAVDEX_ROOT_MATCH_FILES ?? '10000'
  assert.ok(['10000', '100000'].includes(rawCount), 'JAVDEX_ROOT_MATCH_FILES must be 10000 or 100000')
  const fileCount = Number(rawCount)
  const base = path.resolve('/__javdex_synthetic_root_matcher__')
  const results: unknown[] = []

  for (const rootCount of [1, 100, 1000]) {
    const roots: Root[] = Array.from({ length: rootCount }, (_, index) => ({
      id: index + 1,
      // Every tenth root is nested beneath an earlier root: preserve first-root semantics.
      path: index > 0 && index % 10 === 0
        ? path.join(base, 'logical', `root-${index - 1}`, 'nested')
        : path.join(base, 'logical', `root-${index}`),
      realPath: index % 3 === 2 ? null : path.join(base, 'physical', `root-${index}`)
    }))
    // A later root's logical path also aliases the first root's physical path.
    if (roots.length > 1) roots[roots.length - 1].path = roots[0].realPath!
    const files = Array.from({ length: fileCount }, (_, index) => {
      const root = roots[Math.floor(index / 8) % rootCount]
      const filename = `file-${index}.mp4`
      switch (index % 8) {
        case 0: return path.join(root.path, filename)
        case 1: return path.join(root.realPath ?? path.join(base, 'absent-physical'), filename)
        case 2: return root.path
        case 3: return path.join(`${root.path}-sibling`, filename)
        case 4: return path.join(base, 'unmatched', filename)
        case 5: return path.join(root.path, 'nested', filename)
        case 6: return `${root.path}${path.sep}sub${path.sep}..${path.sep}${filename}`
        default: return path.join(root.realPath ?? path.join(base, 'absent-physical'), 'nested', filename)
      }
    })

    for (const includeRealPath of [false, true]) {
      const legacy: Match = (filePath) => roots.find((root) =>
        isPathUnderRoot(filePath, root.path) ||
        Boolean(includeRealPath && root.realPath && isPathUnderRoot(filePath, root.realPath))
      )
      // Oracle construction is deliberately outside all timing, but adds one legacy pass.
      const expected = files.map(legacy)
      const expectedChecksum = expected.reduce((sum, root, index) => sum + (root?.id ?? 0) * (index + 1), 0)
      const unmatched = expected.filter((root) => root === undefined).length
      assert.ok(unmatched > 0 && unmatched < fileCount)
      assert.ok(Number.isSafeInteger(expectedChecksum))

      for (const mode of ['legacy-find', 'matcher'] as const) {
        const buildSamples: number[] = []
        const matchSamples: number[] = []
        for (let sample = -1; sample < 3; sample++) {
          const buildStart = performance.now()
          const match: Match = mode === 'legacy-find'
            ? legacy
            : createLibraryRootMatcher(roots, includeRealPath)
          const buildMs = performance.now() - buildStart
          const actual = new Array<Root | undefined>(fileCount)
          const matchStart = performance.now()
          for (let index = 0; index < files.length; index++) actual[index] = match(files[index])
          const matchMs = performance.now() - matchStart

          let checksum = 0
          for (let index = 0; index < actual.length; index++) {
            assert.strictEqual(actual[index], expected[index], `${rootCount}/${includeRealPath}/${mode}/${sample}/${index}`)
            checksum += (actual[index]?.id ?? 0) * (index + 1)
          }
          assert.equal(checksum, expectedChecksum)
          if (sample >= 0) {
            buildSamples.push(buildMs)
            matchSamples.push(matchMs)
          }
        }
        results.push({ rootCount, fileCount, includeRealPath, mode, unmatched,
          checksum: expectedChecksum, build: summarize(buildSamples), matching: summarize(matchSamples) })
      }
    }
  }

  console.log(JSON.stringify({ runtime: process.versions, platform: process.platform, arch: process.arch, results, notes: [
    'No filesystem or database access for fixture/matching; all paths are synthetic strings, not existing directories or resolved filesystem symlinks.',
    'Defaults to 10000 files; JAVDEX_ROOT_MATCH_FILES=100000 increases legacy work substantially. Root counts 1/100/1000; both path-only and realPath-enabled modes.',
    'Fixed order: root count ascending, path-only then realPath, legacy then matcher. Each mode one warmup and three hot samples; oracle adds an untimed legacy pass.',
    'Matching includes loop and result-array assignments; allocation, identity assertions, checksum and serialization are excluded. Build is separately timed for each freshly created matcher; legacy has no index build (only function selection).',
    'Identity equality covers all generated paths on every sample, including first-root precedence, aliases, exact roots, normalized dot segments, nested paths and unmatched siblings.',
    'Warm host-path diagnostic only, not p95, cold I/O, Windows path semantics on another OS, memory peaks, event-loop responsiveness or total scan speed. Fixed ordering/JIT/GC can affect comparisons.'
  ] }, null, 2))
})
