import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IPC } from '@shared/ipc-channels'
import { appIpcSchemas } from './ipcCommandSchemas'

test('local model commands reject renderer-selected paths, URLs and arbitrary model identities', () => {
  const schema = appIpcSchemas[IPC.LOCAL_MODELS_COMMAND]
  assert.equal(schema.safeParse([{ action: 'export', model: 'qwen3' }]).success, true)
  assert.equal(schema.safeParse([{ action: 'choose-location' }]).success, true)
  for (const command of [
    { action: 'export', model: 'qwen3', destination: 'C:/Windows' },
    { action: 'delete', model: '../other-files' },
    { action: 'download', model: 'qwen3', url: 'https://example.com/model' },
    { action: 'choose-location', path: 'C:/Windows' },
    { action: 'translation', mode: 'local', fallback: 'online' },
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
