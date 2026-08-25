import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { DEFAULT_SETTINGS } from '@shared/settingsTypes'
import {
  getSettings,
  getEffectiveLlmApiKey,
  getLlmSecretMigrationError,
  getPublicLlmProviderConfigs,
  getSettingsRecoveryNotice,
  migrateRetiredVideoScraperSettings,
  removeUnrecognizedFileFromSnapshot,
  resetSettingsCacheForTests,
  updateSettings
} from './settingsStore'
import {
  setLlmSecretCipherForTests,
  type LlmSecretCipher
} from './llmSecretStore'

let tempRoot: string | null = null
let previousUserData: string | undefined

function writeSettings(value: unknown): void {
  fs.writeFileSync(path.join(tempRoot!, 'settings.json'), JSON.stringify(value), 'utf-8')
  resetSettingsCacheForTests()
}

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-settings-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  setLlmSecretCipherForTests(createTestCipher())
  resetSettingsCacheForTests()
})

afterEach(() => {
  resetSettingsCacheForTests()
  setLlmSecretCipherForTests(null)
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

function createTestCipher(options?: { failEncryption?: boolean }): LlmSecretCipher {
  return {
    state: () => ({ protection: 'secure', backend: 'test-keychain' }),
    encrypt(value) {
      if (options?.failEncryption) throw new Error('test encryption unavailable')
      return Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`, 'utf8')
    },
    decrypt(value) {
      const encoded = value.toString('utf8').replace(/^encrypted:/, '')
      return Buffer.from(encoded, 'base64').toString('utf8')
    }
  }
}

describe('settingsStore avatar composition defaults', () => {
  it('uses the relaxed face-centered composition for settings without legacy values', () => {
    writeSettings({})
    const settings = getSettings()
    assert.equal(settings.avatarCenteringMode, 'face')
    assert.equal(settings.avatarFaceRatio, 0.5)
    assert.equal(settings.avatarPreserveFullHead, false)
  })

  it('keeps legacy presets and explicit user values during migration', () => {
    writeSettings({ avatarFaceScalePreset: 'standard' })
    assert.equal(getSettings().avatarFaceRatio, 0.7)

    writeSettings({
      avatarFaceRatio: 0.64,
      avatarCenteringMode: 'head',
      avatarPreserveFullHead: true
    })
    const settings = getSettings()
    assert.equal(settings.avatarFaceRatio, 0.64)
    assert.equal(settings.avatarCenteringMode, 'head')
    assert.equal(settings.avatarPreserveFullHead, true)
  })
})

describe('settingsStore video card preferences', () => {
  it('keeps resource type badges disabled for new and existing users by default', () => {
    writeSettings({})
    assert.equal(getSettings().showVideoResourceTypeBadges, false)
  })

  it('preserves an explicit resource type badge preference', () => {
    writeSettings({ showVideoResourceTypeBadges: true })
    assert.equal(getSettings().showVideoResourceTypeBadges, true)
  })

  it('defaults video cards to portrait and preserves an explicit landscape preference', () => {
    writeSettings({})
    assert.equal(getSettings().coverDisplayMode, 'portrait')
    writeSettings({ coverDisplayMode: 'landscape' })
    resetSettingsCacheForTests()
    assert.equal(getSettings().coverDisplayMode, 'landscape')
  })
})

describe('settingsStore plugin developer model-turn budget', () => {
  it('retires the old implicit step limit instead of carrying 24 into the new setting', () => {
    writeSettings({ pluginDevAgentMaxSteps: 24 })
    const settings = getSettings()

    assert.equal(settings.pluginDevAgentMaxTurns, 0)
    assert.equal('pluginDevAgentMaxSteps' in settings, false)
  })

  it('defaults to unlimited and preserves an explicit zero limit', () => {
    writeSettings({})
    assert.equal(getSettings().pluginDevAgentMaxTurns, 0)

    writeSettings({ pluginDevAgentMaxTurns: 0 })
    assert.equal(getSettings().pluginDevAgentMaxTurns, 0)
  })

  it('persists a positive limit through the settings interface', () => {
    updateSettings({ pluginDevAgentMaxTurns: 36 })
    assert.equal(getSettings().pluginDevAgentMaxTurns, 36)

    resetSettingsCacheForTests()
    assert.equal(getSettings().pluginDevAgentMaxTurns, 36)
  })

  it('stops rewriting legacy model fields after schema v2 exists', () => {
    writeSettings({
      defaultLlmProviderId: 'openai',
      defaultLlmModelId: 'gpt-5.5',
      pluginDevAgentMaxTurns: 36
    })
    fs.writeFileSync(
      path.join(tempRoot!, 'ai-configuration.json'),
      JSON.stringify({ schemaVersion: 2 }),
      'utf8'
    )

    updateSettings({ theme: 'light' })

    const persisted = JSON.parse(
      fs.readFileSync(path.join(tempRoot!, 'settings.json'), 'utf8')
    ) as Record<string, unknown>
    assert.equal(persisted.theme, 'light')
    assert.equal('defaultLlmProviderId' in persisted, false)
    assert.equal('defaultLlmModelId' in persisted, false)
    assert.equal('pluginDevAgentMaxTurns' in persisted, false)
    assert.equal('pluginDevAgentMaxContextTokens' in persisted, false)
    assert.equal('llmProviderConfigs' in persisted, false)
    assert.equal('customLlmProviders' in persisted, false)
    assert.equal('llmCustomModels' in persisted, false)
  })

  it('does not resurrect legacy model fields when the v2 document is unreadable', () => {
    fs.writeFileSync(path.join(tempRoot!, 'settings.json'), JSON.stringify({
      defaultLlmProviderId: 'openai',
      defaultLlmModelId: 'gpt-5.5',
      pluginDevAgentMaxTurns: 36
    }))
    fs.writeFileSync(path.join(tempRoot!, 'ai-configuration.json'), '{broken')
    resetSettingsCacheForTests()

    updateSettings({ theme: 'light' })

    const persisted = JSON.parse(
      fs.readFileSync(path.join(tempRoot!, 'settings.json'), 'utf8')
    ) as Record<string, unknown>
    assert.equal('defaultLlmProviderId' in persisted, false)
    assert.equal('defaultLlmModelId' in persisted, false)
    assert.equal('pluginDevAgentMaxTurns' in persisted, false)
  })
})

describe('settingsStore deferred library path cleanup', () => {
  it('normalizes unique non-empty roots and preserves them across cache resets', () => {
    writeSettings({
      pendingLibraryPathCleanups: ['/library/a', ' /library/b ', '/library/a', '', 42]
    })

    assert.deepEqual(getSettings().pendingLibraryPathCleanups, ['/library/a', '/library/b'])
    resetSettingsCacheForTests()
    assert.deepEqual(getSettings().pendingLibraryPathCleanups, ['/library/a', '/library/b'])
  })
})

describe('settingsStore persistence', () => {
  it('does not update the cache when the settings file cannot be replaced', () => {
    updateSettings({ autoScanEnabled: false })
    const settingsFile = path.join(tempRoot!, 'settings.json')
    fs.rmSync(settingsFile)
    fs.mkdirSync(settingsFile)

    assert.throws(() => updateSettings({ autoScanEnabled: true }), /保存设置失败/)
    assert.equal(getSettings().autoScanEnabled, false)
  })
})

describe('settingsStore recovery', () => {
  it('backs up malformed JSON, writes defaults, and exposes one recovery notice', () => {
    fs.writeFileSync(path.join(tempRoot!, 'settings.json'), '{broken json', 'utf8')
    resetSettingsCacheForTests()

    const settings = getSettings()
    const notice = getSettingsRecoveryNotice()
    assert.equal(settings.theme, DEFAULT_SETTINGS.theme)
    assert.ok(notice?.backupFileName.startsWith('settings.corrupt-'))
    assert.equal(fs.existsSync(path.join(tempRoot!, notice!.backupFileName)), true)
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(tempRoot!, 'settings.json'), 'utf8')))
  })

  it('does not replace a settings path that fails with an I/O error', () => {
    const settingsPath = path.join(tempRoot!, 'settings.json')
    fs.mkdirSync(settingsPath)
    resetSettingsCacheForTests()

    assert.throws(() => getSettings(), /读取设置失败/)
    assert.equal(fs.statSync(settingsPath).isDirectory(), true)
    assert.equal(getSettingsRecoveryNotice(), null)
  })
})

describe('settingsStore LLM secret migration', () => {
  it('moves legacy API keys out of settings.json without exposing them publicly', () => {
    writeSettings({
      llmProviderConfigs: {
        openai: {
          apiKey: 'sk-legacy-secret',
          baseUrl: 'https://example.test/v1',
          protocol: 'openai-chat'
        }
      }
    })

    const settings = getSettings()
    const persisted = fs.readFileSync(path.join(tempRoot!, 'settings.json'), 'utf8')
    const secretFile = fs.readFileSync(path.join(tempRoot!, 'llm-secrets.json'), 'utf8')

    assert.equal(getEffectiveLlmApiKey('openai'), 'sk-legacy-secret')
    assert.equal(settings.llmProviderConfigs.openai?.baseUrl, 'https://example.test/v1')
    assert.equal(persisted.includes('sk-legacy-secret'), false)
    assert.equal(secretFile.includes('sk-legacy-secret'), false)
    assert.equal(getPublicLlmProviderConfigs(settings).openai?.hasApiKey, true)
  })

  it('keeps the original plaintext file and blocks later writes when migration fails', () => {
    setLlmSecretCipherForTests(createTestCipher({ failEncryption: true }))
    writeSettings({
      theme: 'light',
      llmProviderConfigs: { openai: { apiKey: 'sk-preserve-me' } }
    })

    const settings = getSettings()
    assert.equal(settings.theme, 'light')
    assert.equal(getEffectiveLlmApiKey('openai'), 'sk-preserve-me')
    assert.match(getLlmSecretMigrationError() ?? '', /迁移失败/)
    assert.match(fs.readFileSync(path.join(tempRoot!, 'settings.json'), 'utf8'), /sk-preserve-me/)
    assert.throws(() => updateSettings({ theme: 'graphite' }), /无法安全迁移/)
  })
})

describe('settingsStore scan cleanup defaults', () => {
  it('keeps automatic deletion disabled and has no summary for new and existing users', () => {
    writeSettings({})
    assert.equal(getSettings().autoDeleteResourceLessVideos, false)
    assert.equal(getSettings().lastLibraryScanSummary, null)
    assert.deepEqual(getSettings().unrecognizedFiles, [])
  })

  it('preserves an explicit automatic deletion preference', () => {
    writeSettings({ autoDeleteResourceLessVideos: true })
    assert.equal(getSettings().autoDeleteResourceLessVideos, true)
  })

  it('normalizes and sanitizes the persisted latest scan summary', () => {
    writeSettings({
      lastLibraryScanSummary: {
        trigger: 'interval',
        startedAt: '2026-08-10T01:00:00.000Z',
        finishedAt: '2026-08-10T01:00:02.000Z',
        status: 'failed',
        scannedFiles: 2,
        resourcesAdded: 1,
        resourcesUpdated: 0,
        resourcesRemoved: 0,
        primaryResourcesPromoted: 0,
        videosDeleted: 0,
        skippedFiles: 1,
        failedFiles: 1,
        offlineFolders: ['/offline'],
        errorSummary: 'failed https://example.test/watch?token=secret'
      }
    })

    const summary = getSettings().lastLibraryScanSummary
    assert.equal(summary?.trigger, 'interval')
    assert.equal(summary?.offlineFolders[0], '/offline')
    assert.equal(summary?.errorSummary?.includes('secret'), false)
  })

  it('persists a normalized unrecognized-file snapshot and removes resolved paths', () => {
    writeSettings({
      unrecognizedFiles: ['/library/UNKNOWN.mp4', ' /library/SECOND.mp4 ', '', 42],
      unrecognizedFilesScanFinishedAt: '2026-08-24T01:00:00.000Z'
    })

    assert.deepEqual(getSettings().unrecognizedFiles, [
      '/library/UNKNOWN.mp4',
      '/library/SECOND.mp4'
    ])

    removeUnrecognizedFileFromSnapshot('/library/UNKNOWN.mp4')
    resetSettingsCacheForTests()

    assert.deepEqual(getSettings().unrecognizedFiles, ['/library/SECOND.mp4'])
    assert.equal(
      getSettings().unrecognizedFilesScanFinishedAt,
      '2026-08-24T01:00:00.000Z'
    )

    removeUnrecognizedFileFromSnapshot('/library/SECOND.mp4')
    assert.equal(getSettings().unrecognizedFilesScanFinishedAt, null)
  })
})

describe('settingsStore automatic scan defaults', () => {
  it('keeps automatic scans disabled and defaults to one hour', () => {
    writeSettings({})
    assert.equal(getSettings().autoScanEnabled, false)
    assert.equal(getSettings().autoScanIntervalMinutes, 60)
  })

  it('accepts only supported automatic scan intervals', () => {
    for (const interval of [15, 30, 60, 180, 360]) {
      writeSettings({ autoScanIntervalMinutes: interval })
      assert.equal(getSettings().autoScanIntervalMinutes, interval)
    }
    writeSettings({ autoScanIntervalMinutes: 45 })
    assert.equal(getSettings().autoScanIntervalMinutes, 60)
  })
})

describe('settingsStore retired actress scrapers', () => {
  it('rewrites the retired idol archive default to Xslist', () => {
    writeSettings({ defaultActressScraper: '偶像档案库' })
    assert.equal(getSettings().defaultActressScraper, 'Xslist')
  })

  it('rewrites composite actress field mappings that pointed at the idol archive', () => {
    writeSettings({
      compositeScrapers: {
        video: [],
        actress: [
          {
            kind: 'actress',
            name: 'Legacy Composite',
            fieldPluginMap: {
              avatar: '偶像档案库',
              measurements: 'Xslist'
            }
          }
        ]
      }
    })
    const [composite] = getSettings().compositeScrapers.actress
    assert.equal(composite?.fieldPluginMap.avatar, 'Xslist')
    assert.equal(composite?.fieldPluginMap.measurements, 'Xslist')
  })
})

describe('settingsStore retired video scrapers', () => {
  it('rewrites the retired JAV8 default to JavDB', () => {
    writeSettings({ defaultScraper: 'JAV8' })
    migrateRetiredVideoScraperSettings()
    assert.equal(getSettings().defaultScraper, 'JavDB')
  })

  it('rewrites JAV8 composite mappings and removes its delay', () => {
    writeSettings({
      scraperPluginDelays: {
        video: { JAV8: { minMs: 1000, maxMs: 2000 } },
        actress: {}
      },
      compositeScrapers: {
        video: [
          {
            kind: 'video',
            name: 'Legacy JAV8 Fields',
            fieldPluginMap: { title: 'JavLibrary', cover: 'JAV8' }
          }
        ],
        actress: []
      }
    })

    migrateRetiredVideoScraperSettings()
    const settings = getSettings()
    assert.equal(settings.scraperPluginDelays.video.JAV8, undefined)
    assert.deepEqual(settings.compositeScrapers.video[0]?.fieldPluginMap, {
      title: 'JavLibrary',
      cover: 'JavDB'
    })
  })
})

describe('settingsStore privacy mode', () => {
  it('defaults to disabled with every image scope selected', () => {
    writeSettings({})
    const settings = getSettings()
    assert.equal(settings.privacyModeEnabled, false)
    assert.deepEqual(settings.privacyModeScopes, [
      'covers',
      'videoSamples',
      'actressGallery',
      'actressDefaultAvatar',
      'imagePreview',
      'mediaEditors',
      'globalBackground'
    ])
  })

  it('keeps valid unique scopes and discards unknown values', () => {
    writeSettings({
      privacyModeEnabled: true,
      privacyModeScopes: ['videoSamples', 'unknown', 'videoSamples', 'covers']
    })
    const settings = getSettings()
    assert.equal(settings.privacyModeEnabled, true)
    assert.deepEqual(settings.privacyModeScopes, ['videoSamples', 'covers'])
  })

  it('keeps samples and actress galleries independently selectable', () => {
    writeSettings({
      privacyModeEnabled: true,
      privacyModeScopes: ['videoSamples']
    })
    assert.deepEqual(getSettings().privacyModeScopes, ['videoSamples'])
  })

  it('allows all privacy scopes to be cleared explicitly', () => {
    writeSettings({ privacyModeEnabled: true, privacyModeScopes: [] })
    assert.deepEqual(getSettings().privacyModeScopes, [])
  })
})
