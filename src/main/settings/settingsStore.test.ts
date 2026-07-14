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
