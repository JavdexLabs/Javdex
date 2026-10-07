import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IPC } from '@shared/ipc-channels'
import { appIpcSchemas } from './ipcCommandSchemas'

test('local model commands reject renderer-selected paths, URLs and arbitrary model identities', () => {
  const schema = appIpcSchemas[IPC.LOCAL_MODELS_COMMAND]
  assert.equal(schema.safeParse([{ action: 'export', model: 'qwen3' }]).success, true)
  assert.equal(schema.safeParse([{ action: 'choose-location' }]).success, true)
  assert.equal(schema.safeParse([{ action: 'select', model: 'qwen3', variant: 'qwen3-official-q8_0' }]).success, true)
  assert.equal(schema.safeParse([{ action: 'download', model: 'kotoba', variant: 'kotoba-f16' }]).success, true)
  assert.equal(schema.safeParse([{ action: 'download', model: 'hy-mt2-7b', variant: 'hy-mt2-7b-q6_k' }]).success, true)
  assert.equal(schema.safeParse([{ action: 'translation-model', model: 'hy-mt2-7b' }]).success, true)
  assert.equal(schema.safeParse([{ action: 'translation-model', model: 'index-translate-9b' }]).success, true)
  assert.equal(schema.safeParse([{ action: 'download', model: 'index-translate-9b', variant: 'index-translate-9b-f16' }]).success, true)
  for (const command of [
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
