import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { LOCAL_MODEL_ASSETS } from './runtimeManifest'
import { DEFAULT_LOCAL_MODEL_VARIANTS, LOCAL_MODEL_VARIANTS, localModelAssets, localModelVariant } from './modelCatalog'
import { isSpeechModel } from '@shared/desktop/localModels'
import { createAiRuntimeInstaller } from './runtimeInstaller'

test('catalog enumerates curated published assets with immutable provenance and unique precision identities', () => {
  assert.equal(LOCAL_MODEL_VARIANTS.length, 10)
  assert.equal(new Set(LOCAL_MODEL_VARIANTS.map(item => item.id)).size, 10)
  assert.deepEqual(LOCAL_MODEL_VARIANTS.filter(item => item.model === 'kotoba').map(item => item.precision).sort(), ['F16', 'Q5_0'])
  assert.equal(LOCAL_MODEL_VARIANTS.filter(item => item.publisher === 'bartowski').length, 3)
  assert.equal(LOCAL_MODEL_VARIANTS.filter(item => item.publisher === 'Qwen').length, 1)
  assert.deepEqual(LOCAL_MODEL_VARIANTS.filter(item => item.model === 'hy-mt2-7b').map(item => item.precision), ['Q4_K_M', 'Q6_K', 'Q8_0'])
  for (const item of LOCAL_MODEL_VARIANTS) {
    assert.match(item.asset.url, /^https:\/\/huggingface\.co\/(?:kotoba-tech|Qwen|bartowski|tencent|audio-cpp)\/[^/]+\/resolve\/[a-f0-9]{40}\/.+$/)
    assert.match(item.asset.sha256, /^[a-f0-9]{64}$/)
    assert.ok(Number.isSafeInteger(item.asset.bytes) && item.asset.bytes > 0)
    assert.equal(path.basename(item.asset.filename), item.asset.filename)
    assert.equal(item.recommended, item.id === DEFAULT_LOCAL_MODEL_VARIANTS[item.model])
  }
  assert.deepEqual(LOCAL_MODEL_VARIANTS.filter(item => item.model === 'qwen3').map(item => item.id), [
    'qwen3-q4_k_m', 'qwen3-q5_k_m', 'qwen3-q6_k', 'qwen3-official-q8_0'
  ])
  assert.throws(() => localModelVariant('qwen3', 'kotoba-q5_0'), /不匹配/)
})

test('default weights preserve upstream names and selecting a precision preserves all shared runtime assets', () => {
  for (const id of ['kotoba', 'qwen3'] as const) {
    const original = LOCAL_MODEL_ASSETS.find(item => item.id === (id === 'kotoba' ? 'kotoba' : 'translation-model'))!
    assert.equal(localModelVariant(id).asset.sha256, original.sha256)
    assert.equal(localModelVariant(id).asset.filename, original.filename)
  }
  const selected = localModelAssets({ ...DEFAULT_LOCAL_MODEL_VARIANTS, kotoba: 'kotoba-f16', qwen3: 'qwen3-official-q8_0' }, 'qwen3', { platform: 'win32', arch: 'x64' })
  for (const original of LOCAL_MODEL_ASSETS.filter(item => item.id !== 'kotoba' && item.id !== 'translation-model')) {
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

test('mirror preserves every pinned model identity and only rewrites Hugging Face downloads', () => {
  for (const variant of LOCAL_MODEL_VARIANTS) {
    const selection = { ...DEFAULT_LOCAL_MODEL_VARIANTS, [variant.model]: variant.id }
    const model = isSpeechModel(variant.model) ? 'qwen3' : variant.model
    const original = localModelAssets(selection, model)
    const mirrored = localModelAssets(selection, model, undefined, 'hf-mirror')
    original.forEach((asset, index) => {
      const expected = asset.url.replace('https://huggingface.co/', 'https://hf-mirror.com/')
      assert.deepEqual(mirrored[index], { ...asset, url: expected })
    })
    assert.deepEqual(localModelAssets(selection, model), original)
  }
})

test('Qwen subtitle cache identity includes both models and never changes the preserved Kotoba identity', () => {
  const assets = localModelAssets(DEFAULT_LOCAL_MODEL_VARIANTS)
  const options = { recognitionModel: 'qwen3-asr' as const }
  const original = createAiRuntimeInstaller('/models', undefined, assets, options).paths()
  const changedAligner = createAiRuntimeInstaller('/models', undefined, assets.map(asset => asset.id === 'qwen-aligner' ? { ...asset, sha256: 'a'.repeat(64) } : asset), options).paths()
  const changedAsr = createAiRuntimeInstaller('/models', undefined, assets.map(asset => asset.id === 'qwen-asr' ? { ...asset, sha256: 'b'.repeat(64) } : asset), options).paths()
  assert.notEqual(original.asrVersion, changedAligner.asrVersion)
  assert.notEqual(original.asrVersion, changedAsr.asrVersion)
  const kotoba = createAiRuntimeInstaller('/models', undefined, assets).paths()
  assert.equal(kotoba.asrVersion, localModelVariant('kotoba').asset.sha256)
  assert.notEqual(kotoba.asrVersion, original.asrVersion)
  assert.equal(kotoba.kotoba, original.kotoba)
})
