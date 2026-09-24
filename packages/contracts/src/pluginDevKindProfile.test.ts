import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  allFieldIdsForKind,
  fieldLabelForKind,
  getPluginDevKindProfile,
  normalizeTestTargets,
  parseTestTargetList,
  resolveRunTargetsFromArgs,
  testTargetsFromDryRun
} from './pluginDevKindProfile'

describe('pluginDevKindProfile', () => {
  it('normalizes testTarget and testTargets', () => {
    assert.deepEqual(normalizeTestTargets({ testTargets: ['A', 'B'] }), ['A', 'B'])
    assert.deepEqual(normalizeTestTargets({ testTarget: 'X', testTargets: ['Y'] }), ['X', 'Y'])
    assert.deepEqual(normalizeTestTargets({ testTarget: '  Alice  ' }), ['Alice'])
  })

  it('splits test targets only on commas or newlines and trims each group', () => {
    assert.deepEqual(
      parseTestTargetList('  Yua Mikami  , 三上悠亜\r\n  Saika Kawakita ， 河北彩花  '),
      ['Yua Mikami', '三上悠亜', 'Saika Kawakita', '河北彩花']
    )
    assert.deepEqual(parseTestTargetList('ABC-1 ABC-2;ABC-3'), ['ABC-1 ABC-2;ABC-3'])
  })

  it('uses typed explicit targets as a diagnostic subset', () => {
    assert.deepEqual(
      resolveRunTargetsFromArgs('video', { videoCodes: ['A'] }, [
        { kind: 'video', code: 'A' }, { kind: 'video', code: 'B' }
      ]),
      { explicit: true, targets: [{ kind: 'video', code: 'A' }] }
    )
    assert.deepEqual(
      resolveRunTargetsFromArgs('actress', { actresses: [{
        mainName: '三上悠亜', aliases: ['Yua Mikami']
      }] }, []),
      {
        explicit: true,
        targets: [{ kind: 'actress', mainName: '三上悠亜', aliases: ['Yua Mikami'] }]
      }
    )
  })

  it('rejects URL/path targets and wrong-kind arguments', () => {
    assert.throws(
      () => resolveRunTargetsFromArgs('video', { videoCodes: ['https://example.test/ABC-1'] }, []),
      /RUN_TARGET_INVALID|不能是 URL/
    )
    assert.throws(
      () => resolveRunTargetsFromArgs('actress', { actresses: [{ mainName: '/profile/7' }] }, []),
      /不能是 URL 或路径/
    )
    assert.throws(
      () => resolveRunTargetsFromArgs('video', { actresses: [{ mainName: 'Alice' }] }, []),
      /只能使用 videoCodes/
    )
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
})
