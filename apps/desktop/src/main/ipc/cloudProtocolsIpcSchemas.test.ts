import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IPC } from '@shared/ipc-channels'
import { appIpcSchemas } from './ipcCommandSchemas'

test('model connection IPC accepts all supported cloud protocols and rejects unknown protocols', () => {
  const schema = appIpcSchemas[IPC.SETTINGS_MODEL_MANAGEMENT_APPLY]
  const command = (protocol: string) => [{
    expectedRevision: 'revision',
    command: { type: 'save-connection', connection: {
      providerId: 'custom-test', name: 'Test', source: 'custom', protocol,
      baseUrl: 'https://example.test/v1', apiKeyAction: 'keep'
    } }
  }]
  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages', 'google-generative-ai']) {
    assert.equal(schema.safeParse(command(protocol)).success, true, protocol)
  }
  assert.equal(schema.safeParse(command('unsupported')).success, false)
})
