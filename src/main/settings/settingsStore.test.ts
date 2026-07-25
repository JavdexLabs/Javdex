import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { getSettings, resetSettingsCacheForTests } from './settingsStore'

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
