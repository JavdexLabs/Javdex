import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { AI_SUBTITLE_ASSETS } from '../../player/aiSubtitles/runtimeManifest'
import { DEFAULT_LOCAL_MODEL_VARIANTS, LOCAL_MODEL_VARIANTS, localModelAssets, localModelVariant } from './modelCatalog'

test('catalog enumerates every published standalone asset with immutable provenance and unique precision identities', () => {
  assert.equal(LOCAL_MODEL_VARIANTS.length, 42)
  assert.equal(new Set(LOCAL_MODEL_VARIANTS.map(item => item.id)).size, 42)
  assert.deepEqual(LOCAL_MODEL_VARIANTS.filter(item => item.model === 'kotoba').map(item => item.precision).sort(), ['F16', 'Q5_0'])
  assert.equal(LOCAL_MODEL_VARIANTS.filter(item => item.publisher === 'bartowski').length, 24)
  assert.equal(LOCAL_MODEL_VARIANTS.filter(item => item.publisher === 'Qwen').length, 1)
  assert.deepEqual(LOCAL_MODEL_VARIANTS.filter(item => item.model === 'hy-mt2-7b').map(item => item.precision), ['Q4_K_M', 'Q6_K', 'Q8_0'])
  for (const item of LOCAL_MODEL_VARIANTS) {
    assert.match(item.asset.url, /^https:\/\/huggingface\.co\/(?:kotoba-tech|Qwen|bartowski|tencent|IndexTeam)\/[^/]+\/resolve\/[a-f0-9]{40}\/[^/]+$/)
    assert.match(item.asset.sha256, /^[a-f0-9]{64}$/)
    assert.ok(Number.isSafeInteger(item.asset.bytes) && item.asset.bytes > 0)
    assert.equal(path.basename(item.asset.filename), item.asset.filename)
    assert.equal(item.recommended, item.id === DEFAULT_LOCAL_MODEL_VARIANTS[item.model])
  }
  assert.notEqual(localModelVariant('qwen3', 'qwen3-q8_0').asset.sha256, localModelVariant('qwen3', 'qwen3-official-q8_0').asset.sha256)
  assert.throws(() => localModelVariant('qwen3', 'kotoba-q5_0'), /不匹配/)
})

test('default weights reuse legacy on-disk names and selecting a precision preserves all shared runtime assets', () => {
  for (const id of ['kotoba', 'qwen3'] as const) {
    const original = AI_SUBTITLE_ASSETS.find(item => item.id === (id === 'kotoba' ? 'kotoba' : 'translation-model'))!
    assert.equal(localModelVariant(id).asset.sha256, original.sha256)
    assert.equal(localModelVariant(id).asset.filename, original.filename)
  }
  const selected = localModelAssets({ ...DEFAULT_LOCAL_MODEL_VARIANTS, kotoba: 'kotoba-f16', qwen3: 'qwen3-official-q8_0' }, 'qwen3', { platform: 'win32', arch: 'x64' })
  for (const original of AI_SUBTITLE_ASSETS.filter(item => item.id !== 'kotoba' && item.id !== 'translation-model')) {
    assert.equal(selected.find(item => item.id === original.id), original)
  }
  assert.equal(selected.find(item => item.id === 'translation-model')!.url, localModelVariant('qwen3', 'qwen3-official-q8_0').asset.url)
})

test('HY 7B catalog preserves official filename casing and selects only the chosen translation family', () => {
  const entries = LOCAL_MODEL_VARIANTS.filter(item => item.model === 'hy-mt2-7b')
  assert.deepEqual(entries.map(item => [item.asset.filename, item.asset.bytes]), [
    ['Hy-MT2-7B-Q4_K_M.gguf', 4624648896], ['HY-MT2-7B-Q6_K.gguf', 6164482720], ['HY-MT2-7B-Q8_0.gguf', 7981928896]
  ])
  for (const entry of entries) {
    assert.equal(entry.publisher, 'tencent')
    assert.equal(entry.asset.translationModelId, 'hy-mt2-7b')
    assert.match(entry.asset.url, /\/ab8472660ac61fac25f1af43fac2599d52a8a775\//)
  }
  const selected = localModelAssets({ ...DEFAULT_LOCAL_MODEL_VARIANTS, 'hy-mt2-7b': 'hy-mt2-7b-q6_k' }, 'hy-mt2-7b')
  assert.equal(selected.find(item => item.id === 'translation-model')!.filename, 'HY-MT2-7B-Q6_K.gguf')
  assert.equal(selected.filter(item => item.id === 'translation-model').length, 1)
  assert.throws(() => localModelVariant('qwen3', 'hy-mt2-7b-q6_k'), /不匹配/)
  assert.throws(() => localModelVariant('hy-mt2-7b', 'qwen3-q4_k_m'), /不匹配/)
  assert.throws(() => localModelVariant('hy-mt2-7b', 'hy-mt2-7b-1.25bit'), /不匹配/)
})

test('Index 9B lists all twelve official text precisions without mixing in vision, speech or other sizes', () => {
  const entries = LOCAL_MODEL_VARIANTS.filter(item => item.model === 'index-translate-9b')
  assert.deepEqual(entries.map(item => item.precision), [
    'Q2_K', 'Q3_K_S', 'Q3_K_M', 'Q3_K_L', 'IQ4_XS', 'Q4_K_S', 'Q4_K_M', 'Q5_K_S', 'Q5_K_M', 'Q6_K', 'Q8_0', 'F16'
  ])
  for (const entry of entries) {
    assert.equal(entry.publisher, 'IndexTeam')
    assert.equal(entry.asset.translationModelId, 'index-translate-9b')
    assert.match(entry.asset.filename, /^Index-Translate-9B\.(?:Q\d_K_[SML]|Q[26]_K|Q8_0|IQ4_XS|f16)\.gguf$/)
    assert.match(entry.asset.url, /\/d01404384ba429b93f5f63d43573812d103b5bcd\//)
  }
  assert.equal(localModelVariant('index-translate-9b').asset.bytes, 5780090304)
  const selected = localModelAssets({ ...DEFAULT_LOCAL_MODEL_VARIANTS, 'index-translate-9b': 'index-translate-9b-f16' }, 'index-translate-9b')
  assert.equal(selected.find(item => item.id === 'translation-model')!.filename, 'Index-Translate-9B.f16.gguf')
  assert.equal(selected.filter(item => item.id === 'translation-model').length, 1)
  assert.throws(() => localModelVariant('index-translate-9b', 'index-translate-9b-mmproj-q8_0'), /不匹配/)
  assert.throws(() => localModelVariant('index-translate-9b', 'hy-mt2-7b-q4_k_m'), /不匹配/)
  assert.throws(() => localModelVariant('qwen3', 'index-translate-9b-q4_k_m'), /不匹配/)
})
