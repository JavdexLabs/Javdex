import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IPC } from '@shared/ipc-channels'
import { appIpcSchemas } from './ipcCommandSchemas'

test('Qwen ForcedAligner toggle accepts only a boolean and optional revision', () => {
  const schema = appIpcSchemas[IPC.LOCAL_MODELS_COMMAND]
  for (const enabled of [true, false]) assert.equal(schema.safeParse([{ action: 'qwen-forced-aligner', enabled, expectedRevision: 'r1' }]).success, true)
  for (const command of [
    { action: 'qwen-forced-aligner' }, { action: 'qwen-forced-aligner', enabled: 'false' },
    { action: 'qwen-forced-aligner', enabled: false, path: 'C:/external.gguf' }
  ]) assert.equal(schema.safeParse([command]).success, false)
})

test('local model commands reject renderer-selected paths, URLs and arbitrary model identities', () => {
  const schema = appIpcSchemas[IPC.LOCAL_MODELS_COMMAND]
  assert.equal(schema.safeParse([{ action: 'export', model: 'qwen3' }]).success, true)
  assert.equal(schema.safeParse([{ action: 'choose-location' }]).success, true)
  for (const action of ['clean-downloads', 'clear-cache', 'open-location', 'refresh-storage']) {
    assert.equal(schema.safeParse([{ action }]).success, true)
    assert.equal(schema.safeParse([{ action, path: 'C:/Windows' }]).success, false)
  }
  assert.equal(schema.safeParse([{ action: 'select', model: 'qwen3', variant: 'qwen3-official-q8_0' }]).success, true)
  assert.equal(schema.safeParse([{ action: 'download', model: 'kotoba', variant: 'kotoba-f16' }]).success, true)
  assert.equal(schema.safeParse([{ action: 'download', model: 'hy-mt2-7b', variant: 'hy-mt2-7b-q6_k' }]).success, true)
  assert.equal(schema.safeParse([{ action: 'translation-model', model: 'hy-mt2-7b' }]).success, true)
  assert.equal(schema.safeParse([{ action: 'translation-model', model: 'index-translate-9b' }]).success, false)
  assert.equal(schema.safeParse([{ action: 'download', model: 'index-translate-9b', variant: 'index-translate-9b-f16' }]).success, false)
  assert.equal(schema.safeParse([{ action: 'download-source', source: 'hf-mirror' }]).success, true)
  for (const action of ['import', 'copy-download-url']) assert.equal(schema.safeParse([{ action, model: 'qwen3', variant: 'qwen3-official-q8_0' }]).success, true)
  for (const command of [
    { action: 'import', model: 'qwen3', source: 'C:/untrusted.gguf' },
    { action: 'copy-download-url', model: 'qwen3', url: 'https://example.com' },
    { action: 'download-source', source: 'https://example.com' },
    { action: 'export', model: 'qwen3', destination: 'C:/Windows' },
    { action: 'delete', model: '../other-files' },
    { action: 'download', model: 'qwen3', url: 'https://example.com/model' },
    { action: 'download', model: 'qwen3', variant: 'kotoba-q5_0' },
    { action: 'select', model: 'qwen3' },
    { action: 'select', model: 'qwen3', variant: 'qwen3-q999' },
    { action: 'delete', model: 'kotoba', variant: '../other-file' },
    { action: 'choose-location', path: 'C:/Windows' },
    { action: 'translation', mode: 'local', fallback: 'online' },
    { action: 'translation-model', model: 'kotoba' },
    { action: 'translation-model', model: 'hy-mt2-30b' },
    { action: 'translation-model', model: 'hy-mt2-7b', variant: 'hy-mt2-7b-q8_0' },
    { action: 'select', model: 'hy-mt2-7b', variant: 'qwen3-q4_k_m' },
    { action: 'download', model: 'hy-mt2-7b', variant: 'hy-mt2-7b-1.25bit' },
    { action: 'translation-model', model: 'index-translate-2b' },
    { action: 'translation-model', model: 'index-echo-9b' },
    { action: 'select', model: 'index-translate-9b', variant: 'index-translate-9b-mmproj-q8_0' },
    { action: 'select', model: 'index-translate-9b', variant: 'qwen3-q4_k_m' },
    { action: 'download', model: 'hy-mt2-7b', variant: 'index-translate-9b-q4_k_m' },
    { action: 'run', command: 'arbitrary executable' }
  ]) assert.equal(schema.safeParse([command]).success, false)
  assert.equal(appIpcSchemas[IPC.LOCAL_MODELS_SNAPSHOT].safeParse(['C:/Windows']).success, false)
})

test('player subtitle IPC cannot bypass the central model management and deletion confirmation', () => {
  const schema = appIpcSchemas[IPC.PLAYBACK_AI_SUBTITLE_COMMAND]
  const sessionId = 'b459a833-03fb-4c57-bc31-a1fc8f8e09ca'
  assert.equal(schema.safeParse([sessionId, { action: 'start' }]).success, true)
  for (const action of ['install', 'cancel-install', 'remove-models']) {
    assert.equal(schema.safeParse([sessionId, { action }]).success, false)
  }
})

test('runtime deletion accepts only a whole environment and rejects individual components or renderer paths', () => {
  const schema = appIpcSchemas[IPC.LOCAL_MODELS_COMMAND]
  for (const group of ['speech', 'qwen-speech', 'text']) for (const target of ['cpu', 'gpu']) {
    assert.equal(schema.safeParse([{ action: 'delete-runtime', group, target }]).success, true)
  }
  for (const command of [
    { action: 'delete-runtime', group: 'all', target: 'cpu' },
    { action: 'delete-runtime', group: 'text', target: 'translator-cpu' },
    { action: 'delete-runtime', components: ['../Windows'] },
    { action: 'delete-runtime', group: 'text', target: 'gpu', path: 'C:/Windows' },
    { action: 'delete-runtime', group: 'text', target: 'gpu', components: ['translator-cuda'] }
  ]) assert.equal(schema.safeParse([command]).success, false)
})

test('purpose bindings allow independent exact variants but reject cross-family or injected identities', () => {
  const schema = appIpcSchemas[IPC.LOCAL_MODELS_COMMAND]
  const usage = {
    subtitleRecognition: { model: 'kotoba', variant: 'kotoba-q5_0' },
    subtitleTranslation: { model: 'qwen3', variant: 'qwen3-q4_k_m' },
    textTranslation: { mode: 'local', model: 'qwen3', variant: 'qwen3-official-q8_0' }
  }
  assert.equal(schema.safeParse([{ action: 'usage', usage, expectedRevision: 'current-revision' }]).success, true)
  assert.equal(schema.safeParse([{ action: 'usage', usage: { ...usage, subtitleRecognition: { model: 'qwen3-asr', variant: 'qwen3-asr-bf16' } } }]).success, true)
  for (const invalid of [
    { ...usage, subtitleRecognition: { model: 'qwen3', variant: 'qwen3-q4_k_m' } },
    { ...usage, subtitleTranslation: { model: 'qwen3', variant: 'hy-mt2-7b-q8_0' } },
    { ...usage, textTranslation: { ...usage.textTranslation, variant: '../file.gguf' } },
    { ...usage, textTranslation: { ...usage.textTranslation, mode: 'online-fallback' } },
    { ...usage, subtitleTranslation: { ...usage.subtitleTranslation, path: 'C:/external.gguf' } }
  ]) assert.equal(schema.safeParse([{ action: 'usage', usage: invalid }]).success, false)
})

test('shared runtime preparation accepts only a known modality and a managed preparation target', () => {
  const schema = appIpcSchemas[IPC.LOCAL_MODELS_COMMAND]
  for (const group of ['speech', 'qwen-speech', 'text']) for (const target of ['auto', 'cpu', 'gpu']) {
    assert.equal(schema.safeParse([{ action: 'prepare-runtime', group, target }]).success, true)
  }
  for (const command of [
    { action: 'prepare-runtime', group: 'all', target: 'gpu' },
    { action: 'prepare-runtime', group: 'text', target: 'cuda' },
    { action: 'prepare-runtime', group: 'text', target: 'auto', path: 'C:/Windows' },
    { action: 'prepare-runtime', group: 'text', target: 'gpu', url: 'https://untrusted.example/runtime.zip' },
    { action: 'prepare-runtime', group: 'text', target: 'gpu', model: 'kotoba' }
  ]) assert.equal(schema.safeParse([command]).success, false)
})
