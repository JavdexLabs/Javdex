import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createScraperPreLoginSession } from './scraperPreLogin'
import { updateSettings, resetSettingsCacheForTests } from '../settings/settingsStore'

let tempRoot: string | null = null
let oldUserData: string | null = null
let oldBundledRoot: string | null = null

describe('scraper pre-login session', () => {
  beforeEach(() => {
    oldUserData = process.env.JAVDEX_TEST_USER_DATA ?? null
    oldBundledRoot = process.env.JAVDEX_BUNDLED_PLUGINS_ROOT ?? null
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-prelogin-'))
    process.env.JAVDEX_TEST_USER_DATA = tempRoot
    process.env.JAVDEX_BUNDLED_PLUGINS_ROOT = path.join(process.cwd(), 'src/main/bundled-plugins')
    resetSettingsCacheForTests()
  })

  afterEach(() => {
    resetSettingsCacheForTests()
    if (oldUserData == null) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = oldUserData
    if (oldBundledRoot == null) delete process.env.JAVDEX_BUNDLED_PLUGINS_ROOT
    else process.env.JAVDEX_BUNDLED_PLUGINS_ROOT = oldBundledRoot
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  })

  it('opens each enabled plugin homepage once then skips later ensures', async () => {
    updateSettings({
      scraperPluginPreLogin: {
        video: { JavDB: true, JavLibrary: true },
        actress: {}
      }
    })
    const opened: string[] = []
    const waiting: string[] = []
    const session = createScraperPreLoginSession({
      onWaiting: (event) => waiting.push(event.pluginName),
      waitForHomepage: async ({ url, pluginName }) => {
        opened.push(`${pluginName}:${url}`)
      }
    })

    await session.ensure('video', 'JavDB')
    await session.ensure('video', 'JavDB')
    await session.ensure('video', 'JavLibrary')
    await session.ensure('video', 'MetaTube')

    assert.deepEqual(waiting, ['JavDB', 'JavLibrary'])
    assert.deepEqual(opened, ['JavDB:https://javdb.com/', 'JavLibrary:https://www.javlibrary.com/'])
  })

  it('skips GitHub and API plugins even if the stored flag is true', async () => {
    updateSettings({
      scraperPluginPreLogin: {
        video: { MetaTube: true, JavDB: false },
        actress: { Gfriends: true }
      }
    })
    const opened: string[] = []
    const session = createScraperPreLoginSession({
      waitForHomepage: async ({ pluginName }) => {
        opened.push(pluginName)
      }
    })

    await session.ensure('video', 'MetaTube')
    await session.ensure('video', 'JavDB')
    await session.ensure('actress', 'Gfriends')

    assert.deepEqual(opened, [])
  })

  it('coalesces overlapping ensure calls for the same plugin', async () => {
    updateSettings({
      scraperPluginPreLogin: {
        video: { JavDB: true },
        actress: {}
      }
    })
    let release!: () => void
    let started = 0
    const session = createScraperPreLoginSession({
      waitForHomepage: () => {
        started += 1
        return new Promise<void>((resolve) => {
          release = resolve
        })
      }
    })

    const first = session.ensure('video', 'JavDB')
    const second = session.ensure('video', 'JavDB')
    await Promise.resolve()
    assert.equal(started, 1)
    release()
    await Promise.all([first, second])
    await session.ensure('video', 'JavDB')
    assert.equal(started, 1)
  })
})
