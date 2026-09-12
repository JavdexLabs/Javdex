import { it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeVideoCode } from '@shared/videoCode'
import { appendDirectoryVideoCode, sameLogicalCode, summarizeDirectoryVideoCodes } from './directoryVideoIdentity'

// Original nfoSidecarLocator predicate, retained as an independent array oracle.
function legacy(values: readonly (string | null)[]): boolean {
  if (values.length === 1) return true
  const normalized = values.map((value) => {
    if (!value) return null
    try { return normalizeVideoCode(value) } catch { return null }
  })
  return normalized.length > 0 && normalized.every((value) => value && value === normalized[0])
}

for (const [values, expected] of [
  [[], false], [[null], true], [[''], true], [['   '], true], [[null, null], false],
  [['abc-001', ' ABC-001 '], true], [['ABC-001', 'DEF-001'], false],
  [['abc', null], false], [[' ', ' '], false], [[null, 'abc'], false]
] as const) {
  it(`preserves the explicit array oracle for ${JSON.stringify(values)}`, () => {
    assert.equal(legacy(values), expected)
    assert.equal(sameLogicalCode(values), expected)
    assert.equal(sameLogicalCode(summarizeDirectoryVideoCodes(values)), expected)
  })
}

it('matches the old predicate for all short combinations including duplicates and invalid values', () => {
  const choices = [null, '', ' ', 'abc', ' ABC ', 'DEF']
  for (const a of choices) for (const b of choices) for (const c of choices) {
    const values = [a, b, c]
    assert.equal(sameLogicalCode(summarizeDirectoryVideoCodes(values)), legacy(values))
    assert.equal(sameLogicalCode(values), legacy(values))
  }
})

it('retains immutable earlier snapshots while appending and consumes generators once', () => {
  const first = appendDirectoryVideoCode(undefined, ' abc ')
  const second = appendDirectoryVideoCode(first, 'ABC')
  const third = appendDirectoryVideoCode(second, null)
  assert.deepEqual(first, { kind: 'summary', count: 1, normalizedCode: 'ABC', consistent: true })
  assert.deepEqual(second, { kind: 'summary', count: 2, normalizedCode: 'ABC', consistent: true })
  assert.equal(third.count, 3)
  assert.equal(third.consistent, false)
  assert.ok(Object.isFrozen(first) && Object.isFrozen(second) && Object.isFrozen(third))
  assert.notEqual(first, second)
  let yielded = 0
  function* codes() { for (const code of ['abc', 'ABC', ' ABC ']) { yielded++; yield code } }
  assert.equal(sameLogicalCode(summarizeDirectoryVideoCodes(codes())), true)
  assert.equal(yielded, 3)
})


it('reads only the constant summary fields without normalizing its code again', () => {
  let codeReads = 0
  const summary = {
    kind: 'summary' as const, count: 100000, consistent: true,
    get normalizedCode() { codeReads++; return 'ABC' }
  }
  assert.equal(sameLogicalCode(summary), true)
  assert.equal(codeReads, 1)
})
