import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeClassificationName } from './classificationNameNormalization'

describe('normalizeClassificationName', () => {
  it('uses the shared identity normalization without collapsing meaningful script differences', () => {
    assert.equal(normalizeClassificationName('  Ｓ\u3000１\t'), 's1')
    assert.equal(normalizeClassificationName('山田・太郎-Ａ'), '山田・太郎-a')
    assert.equal(normalizeClassificationName(' É COLE '), 'école')
    assert.equal(normalizeClassificationName(' ΑΒΓ '), 'αβγ')
    assert.notEqual(normalizeClassificationName('櫻井'), normalizeClassificationName('樱井'))
    assert.notEqual(normalizeClassificationName('さくら'), normalizeClassificationName('サクラ'))
  })

  it('rejects names that become empty after normalization', () => {
    assert.throws(() => normalizeClassificationName(' \t\n\u3000'), /分类名称不能为空/)
  })
})
