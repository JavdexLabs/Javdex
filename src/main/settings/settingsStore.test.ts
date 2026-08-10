import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
  getSettings,
  migrateRetiredVideoScraperSettings,
  resetSettingsCacheForTests
} from './settingsStore'

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
  resetSettingsCacheForTests()
})

afterEach(() => {
  resetSettingsCacheForTests()
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

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

describe('settingsStore scan cleanup defaults', () => {
  it('keeps automatic deletion disabled and has no summary for new and existing users', () => {
    writeSettings({})
    assert.equal(getSettings().autoDeleteResourceLessVideos, false)
    assert.equal(getSettings().lastLibraryScanSummary, null)
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
