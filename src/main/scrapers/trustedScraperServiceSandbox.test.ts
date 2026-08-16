import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { resetSettingsCacheForTests, updateSettings } from '../settings/settingsStore'
import {
  saveScraperServiceToken,
  setScraperServiceSecretCipherForTests,
  type ScraperServiceSecretCipher
} from '../settings/scraperServiceSecretStore'
import {
  setScraperServiceTransportForTests,
  type ScraperServiceTransportRequest
} from './configuredScraperService'
import { runUserVideoPlugin } from './scraperPluginSandbox'

let tempRoot: string | null = null
let previousUserData: string | undefined

const cipher: ScraperServiceSecretCipher = {
  state: () => ({ protection: 'secure', backend: 'test' }),
  encrypt: (value) => Buffer.from([...value].reverse().join(''), 'utf8'),
  decrypt: (value) => [...value.toString('utf8')].reverse().join('')
}

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-trusted-service-sandbox-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  setScraperServiceSecretCipherForTests(cipher)
  setScraperServiceTransportForTests(null)
  resetSettingsCacheForTests()
})

afterEach(() => {
  setScraperServiceTransportForTests(null)
  setScraperServiceSecretCipherForTests(null)
  resetSettingsCacheForTests()
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('trusted scraper service sandbox bridge', () => {
  it('exposes service methods only to a trusted binding while keeping the token in main', async () => {
    updateSettings({
      scraperServiceConfigs: {
        metatube: { serverUrl: 'https://service.test/prefix', useScrapeProxy: false }
      }
    })
    saveScraperServiceToken('metatube', 'main-only-token')
    const requests: ScraperServiceTransportRequest[] = []
    setScraperServiceTransportForTests(async (request) => {
      requests.push(request)
      return {
        statusCode: 200,
        headers: {},
        body: Buffer.from(JSON.stringify({ data: { title: 'Bridge result' } }), 'utf8')
      }
    })
    const code = `
      module.exports = {
        async parseVideo(ctx) {
          const payload = await ctx.service.getJson('/v1/test', { query: { q: ctx.code } });
          return {
            code: ctx.code,
            title: payload.data.title,
            sourceUrl: ctx.service.publicUrl('/public/image', { id: 1 })
          };
        }
      };
    `

    const result = await runUserVideoPlugin('trusted-bridge', code, 'ABC-123', undefined, 'metatube')
    assert.deepEqual(result, {
      code: 'ABC-123',
      title: 'Bridge result',
      sourceUrl: 'https://service.test/prefix/public/image?id=1'
    })
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.url, 'https://service.test/prefix/v1/test?q=ABC-123')
    assert.equal(requests[0]?.headers.Authorization, 'Bearer main-only-token')

    const ordinaryResult = await runUserVideoPlugin(
      'ordinary-plugin',
      `module.exports = { async parseVideo(ctx) { return { code: ctx.code, title: String(Boolean(ctx.service)) } } }`,
      'ABC-123'
    )
    assert.equal(Array.isArray(ordinaryResult) ? undefined : ordinaryResult?.title, 'false')
  })

  it('fails before starting a trusted worker when the service is not configured', async () => {
    let requestCount = 0
    setScraperServiceTransportForTests(async () => {
      requestCount += 1
      throw new Error('must not run')
    })
    assert.throws(
      () => runUserVideoPlugin(
        'unconfigured-bridge',
        `module.exports = { async parseVideo(ctx) { return { code: ctx.code, title: 'no' } } }`,
        'ABC-123',
        undefined,
        'metatube'
      ),
      /请先配置 MetaTube/
    )
    assert.equal(requestCount, 0)
  })
})
