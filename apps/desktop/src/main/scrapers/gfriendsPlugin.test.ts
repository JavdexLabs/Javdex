import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  runUserActressPlugin,
  setSandboxBufferFetcherForTests
} from './scraperPluginSandbox'
import { isBuiltInScraperName } from './builtInScraperNames'

const GFRIENDS_PLUGIN_PATH = path.join(
  process.cwd(),
  'apps/desktop/src/main/bundled-plugins/actress/Gfriends/index.cjs'
)

let userDataDir: string | null = null
let previousUserData: string | undefined

afterEach(() => {
  setSandboxBufferFetcherForTests()
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  previousUserData = undefined
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true })
  userDataDir = null
})

function installFixtureIndex(index: unknown): void {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-gfriends-plugin-'))
  process.env.JAVDEX_TEST_USER_DATA = userDataDir
  const body = Buffer.from(JSON.stringify(index))
  setSandboxBufferFetcherForTests(async () => ({
    statusCode: 200,
    body,
    etag: '"fixture"'
  }))
}

describe('Gfriends bundled actress plugin', () => {
  it('prefers the main name and selects its last quality-ordered avatar candidate', async () => {
    installFixtureIndex({
      Information: { TotalNum: '3' },
      Content: {
        Low: { '三上悠亞.jpg': 'first.jpg?t=1' },
        High: { '三上悠亞-1.jpg': 'AI-Fix-best.jpg?t=2' },
        LaterAlias: { 'Yua Mikami.jpg': 'alias.jpg?t=3' }
      }
    })
    const code = fs.readFileSync(GFRIENDS_PLUGIN_PATH, 'utf-8')

    const result = await runUserActressPlugin(
      'Gfriends',
      code,
      '三上悠亞',
      ['Yua Mikami']
    )

    assert.deepEqual(result, {
      avatarUrl:
        'https://raw.githubusercontent.com/gfriends/gfriends/master/Content/High/AI-Fix-best.jpg?t=2'
    })
  })

  it('uses the first exact alias only when the main name has no candidate', async () => {
    installFixtureIndex({
      Information: { TotalNum: '2' },
      Content: {
        Earlier: { 'Alias One.jpg': 'first-alias.jpg?t=1' },
        Later: { 'Alias Two.jpg': 'second-alias.jpg?t=2' }
      }
    })
    const code = fs.readFileSync(GFRIENDS_PLUGIN_PATH, 'utf-8')

    const result = await runUserActressPlugin(
      'Gfriends',
      code,
      'Missing Main',
      ['Alias One', 'Alias Two']
    )

    assert.equal(
      result?.avatarUrl,
      'https://raw.githubusercontent.com/gfriends/gfriends/master/Content/Earlier/first-alias.jpg?t=1'
    )
  })

  it('does not return a fuzzy name match', async () => {
    installFixtureIndex({
      Information: { TotalNum: '1' },
      Content: {
        Only: { '三上悠亞.jpg': 'avatar.jpg?t=1' }
      }
    })
    const code = fs.readFileSync(GFRIENDS_PLUGIN_PATH, 'utf-8')

    const result = await runUserActressPlugin('Gfriends', code, '三上', [])

    assert.equal(result, null)
  })

  it('uses the current jsDelivr namespace when the primary index is unavailable', async () => {
    previousUserData = process.env.JAVDEX_TEST_USER_DATA
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-gfriends-plugin-'))
    process.env.JAVDEX_TEST_USER_DATA = userDataDir
    const requestedUrls: string[] = []
    setSandboxBufferFetcherForTests(async (url) => {
      requestedUrls.push(url)
      if (url.startsWith('https://raw.githubusercontent.com/')) {
        throw new Error('primary unavailable')
      }
      return {
        statusCode: 200,
        body: Buffer.from(
          JSON.stringify({
            Content: {
              Studio: { 'Fallback Actress.jpg': 'fallback.jpg?t=4' }
            }
          })
        )
      }
    })
    const code = fs.readFileSync(GFRIENDS_PLUGIN_PATH, 'utf-8')

    const result = await runUserActressPlugin(
      'Gfriends',
      code,
      'Fallback Actress',
      []
    )

    assert.deepEqual(requestedUrls, [
      'https://raw.githubusercontent.com/gfriends/gfriends/master/Filetree.json',
      'https://cdn.jsdelivr.net/gh/gfriends/gfriends@master/Filetree.json'
    ])
    assert.equal(
      result?.avatarUrl,
      'https://cdn.jsdelivr.net/gh/gfriends/gfriends@master/Content/Studio/fallback.jpg?t=4'
    )
  })

  it('reserves Gfriends as a built-in actress plugin name', () => {
    assert.equal(isBuiltInScraperName('actress', 'Gfriends'), true)
  })
})
