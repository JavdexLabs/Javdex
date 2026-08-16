import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { resetSettingsCacheForTests, updateSettings } from '../settings/settingsStore'
import { setScraperServiceSecretCipherForTests } from '../settings/scraperServiceSecretStore'
import { createCompositeScraper } from './scraperPluginService'
import { getScraper, listScraperNames, listScraperPlugins } from './scraperManager'

let tempRoot: string | null = null
let previousUserData: string | undefined
let previousBundledRoot: string | undefined

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  previousBundledRoot = process.env.JAVDEX_BUNDLED_PLUGINS_ROOT
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-scraper-gate-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  process.env.JAVDEX_BUNDLED_PLUGINS_ROOT = path.join(process.cwd(), 'src/main/bundled-plugins')
  setScraperServiceSecretCipherForTests({
    state: () => ({ protection: 'secure', backend: 'test' }),
    encrypt: (value) => Buffer.from(value, 'utf8'),
    decrypt: (value) => value.toString('utf8')
  })
  resetSettingsCacheForTests()
})

afterEach(() => {
  setScraperServiceSecretCipherForTests(null)
  resetSettingsCacheForTests()
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  if (previousBundledRoot === undefined) delete process.env.JAVDEX_BUNDLED_PLUGINS_ROOT
  else process.env.JAVDEX_BUNDLED_PLUGINS_ROOT = previousBundledRoot
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('scraperManager plugin availability gates', () => {
  it('lists MetaTube for configuration but excludes it from executable names until configured', () => {
    const descriptor = listScraperPlugins().find((plugin) => plugin.name === 'MetaTube')
    assert.equal(descriptor?.configured, false)
    assert.equal(listScraperNames().includes('MetaTube'), false)
    assert.throws(() => getScraper('MetaTube'), /请先配置 MetaTube/)
    assert.throws(() => getScraper('Missing plugin'), /不存在/)

    updateSettings({
      scraperServiceConfigs: {
        metatube: { serverUrl: 'https://server.test/prefix', useScrapeProxy: false }
      }
    })
    const configured = listScraperPlugins().find((plugin) => plugin.name === 'MetaTube')
    assert.equal(configured?.configured, true)
    assert.equal(configured?.configurationLabel, 'server.test · Token 未设置')
    assert.equal(listScraperNames().includes('MetaTube'), true)
    assert.equal(getScraper('MetaTube').scraperName, 'MetaTube')
  })

  it('rejects unconfigured service plugins as new composite field sources', () => {
    assert.throws(
      () => createCompositeScraper('video', {
        name: 'MetaTube fields',
        fieldPluginMap: { title: 'MetaTube' }
      }),
      /请先配置 MetaTube/
    )

    updateSettings({
      compositeScrapers: {
        video: [{
          kind: 'video',
          name: 'Legacy MetaTube fields',
          fieldPluginMap: { title: 'MetaTube' }
        }],
        actress: []
      }
    })
    const legacyComposite = listScraperPlugins().find(
      (plugin) => plugin.name === 'Legacy MetaTube fields'
    )
    assert.equal(legacyComposite?.configured, false)
    assert.equal(listScraperNames().includes('Legacy MetaTube fields'), false)
    assert.throws(() => getScraper('Legacy MetaTube fields'), /字段源「MetaTube」尚未配置/)
  })
})
