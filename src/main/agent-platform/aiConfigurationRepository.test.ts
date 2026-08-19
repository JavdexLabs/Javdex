import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settingsTypes'
import { resetLlmSecretStoreForTests } from '../settings/llmSecretStore'
import {
  createAIConfigurationFromLegacySettings,
  validateAIConfiguration
} from './aiConfigurationRepository'

describe('AI configuration V2', () => {
  let userData = ''
  let previousUserData: string | undefined

  beforeEach(() => {
    previousUserData = process.env.JAVDEX_TEST_USER_DATA
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-ai-configuration-'))
    process.env.JAVDEX_TEST_USER_DATA = userData
    resetLlmSecretStoreForTests()
  })

  afterEach(() => {
    resetLlmSecretStoreForTests()
    if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previousUserData
    fs.rmSync(userData, { recursive: true, force: true })
  })

  it('migrates legacy selection into one revision with routes and two concrete profiles', () => {
    const document = createAIConfigurationFromLegacySettings(DEFAULT_SETTINGS, 'fixed-revision')
    assert.equal(document.schemaVersion, 2)
    assert.equal(document.revision, 'fixed-revision')
    assert.equal(document.routes.length, 3)
    assert.deepEqual(
      document.agentProfiles.map((profile) => profile.definitionId),
      ['plugin-developer', 'library-curator']
    )
    assert.deepEqual(validateAIConfiguration(document), [])
  })

  it('keeps custom Anthropic-compatible cache capability unknown without explicit evidence', () => {
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      customLlmProviders: [{
        id: 'custom-anthropic',
        name: 'Custom Anthropic',
        protocol: 'anthropic-messages',
        baseUrl: 'https://example.invalid'
      }],
      llmCustomModels: [{ providerId: 'custom-anthropic', id: 'custom-model', name: 'Custom Model' }],
      llmProviderConfigs: {
        'custom-anthropic': { protocol: 'anthropic-messages', baseUrl: 'https://example.invalid' }
      },
      defaultLlmProviderId: 'custom-anthropic',
      defaultLlmModelId: 'custom-model'
    }
    const document = createAIConfigurationFromLegacySettings(settings)
    const connection = document.modelConnections.find((item) => item.providerId === 'custom-anthropic')
    const model = document.modelRecords.find(
      (item) => item.connectionId === connection?.id && item.modelId === 'custom-model'
    )
    assert.equal(model?.cache.supportsPromptCache, 'unknown')
    assert.equal(model?.cache.supportsLongCacheRetention, false)
  })

  it('fails closed when long retention or role references lack explicit compatibility', () => {
    const document = createAIConfigurationFromLegacySettings(DEFAULT_SETTINGS)
    const preset = document.modelPresets[0]!
    const route = document.routes[0]!
    const model = document.modelRecords.find((item) => item.id === route.modelRecordId)!
    preset.cacheRetention = 'long'
    model.cache.supportsLongCacheRetention = false
    assert.ok(validateAIConfiguration(document).some((error) => error.includes('long cache')))
    document.agentProfiles[0]!.routes.verifier = document.agentProfiles[0]!.routes.primary
    assert.ok(validateAIConfiguration(document).some((error) => error.includes('角色不匹配')))
  })
})
