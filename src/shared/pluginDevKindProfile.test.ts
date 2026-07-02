import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  allFieldIdsForKind,
  buildDryRunToolArgs,
  fieldLabelForKind,
  getPluginDevKindProfile,
  normalizeTestTargets,
  testTargetsFromDryRun
} from './pluginDevKindProfile'

describe('pluginDevKindProfile', () => {
  it('normalizes testTarget and testTargets', () => {
    assert.deepEqual(normalizeTestTargets({ testTargets: ['A', 'B'] }), ['A', 'B'])
    assert.deepEqual(normalizeTestTargets({ testTarget: 'X', testTargets: ['Y'] }), ['X', 'Y'])
    assert.deepEqual(normalizeTestTargets({ testTarget: '  Alice  ' }), ['Alice'])
  })

  it('buildDryRunToolArgs prefers single testTarget', () => {
    assert.deepEqual(buildDryRunToolArgs([]), {})
    assert.deepEqual(buildDryRunToolArgs(['ABC-123']), { testTarget: 'ABC-123' })
    assert.deepEqual(buildDryRunToolArgs(['A', 'B']), { testTargets: ['A', 'B'] })
  })

  it('testTargetsFromDryRun extracts identity from dry-run result', () => {
    assert.deepEqual(
      testTargetsFromDryRun('video', {
        ok: true,
        result: { code: 'ABC-123' },
        logs: []
      }),
      ['ABC-123']
    )
    assert.deepEqual(
      testTargetsFromDryRun('actress', {
        ok: true,
        result: { mainName: 'Alice' },
        cases: [{ target: 'Alice', ok: true, result: { mainName: 'Alice' }, logs: [] }],
        logs: []
      }),
      ['Alice']
    )
  })

  it('profiles expose kind-specific labels and field helpers', () => {
    assert.equal(getPluginDevKindProfile('video').testTargetLabel, '测试番号')
    assert.equal(getPluginDevKindProfile('video').siteUrlLabel, '网站主页')
    assert.equal(getPluginDevKindProfile('actress').testTargetLabel, '测试演员')
    assert.equal(getPluginDevKindProfile('actress').siteUrlLabel, '网站主页')
    assert.equal(fieldLabelForKind('video', 'maker'), '制作商')
    assert.ok(allFieldIdsForKind('video').includes('title'))
  })

  it('summarizeDryRunResult formats kind-specific summaries', () => {
    assert.match(
      getPluginDevKindProfile('video').summarizeDryRunResult({
        maker: 'Muku',
        publisher: 'MUKD',
        title: 'Example'
      }),
      /maker=Muku/
    )
    assert.match(
      getPluginDevKindProfile('actress').summarizeDryRunResult({ mainName: 'Alice' }),
      /mainName=Alice/
    )
  })
})
