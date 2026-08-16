import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { normalizeScraperServiceServerUrl } from '@shared/scraperServiceTypes'
import { getSettings, resetSettingsCacheForTests, updateSettings } from '../settings/settingsStore'
import {
  getScraperServiceToken,
  setScraperServiceSecretCipherForTests,
  type ScraperServiceSecretCipher
} from '../settings/scraperServiceSecretStore'
import {
  clearScraperServiceConfig,
  createConfiguredScraperServiceClient,
  getScraperServicePublicConfig,
  saveScraperServiceConfig,
  ScraperServiceError,
  setScraperServiceTransportForTests,
  testScraperServiceConnection,
  type ScraperServiceTransportRequest,
  type ScraperServiceTransportResponse
} from './configuredScraperService'

let tempRoot: string | null = null
let previousUserData: string | undefined

const cipher: ScraperServiceSecretCipher = {
  state: () => ({ protection: 'secure', backend: 'test' }),
  encrypt: (value) => Buffer.from([...value].reverse().join(''), 'utf8'),
  decrypt: (value) => [...value.toString('utf8')].reverse().join('')
}

function json(statusCode: number, value: unknown, headers = {}): ScraperServiceTransportResponse {
  return {
    statusCode,
    headers,
    body: Buffer.from(JSON.stringify(value), 'utf8')
  }
}

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-configured-scraper-service-'))
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

describe('configuredScraperService', () => {
  it('normalizes legacy settings without a service config and drops an unusable MetaTube default', () => {
    const legacy = { ...getSettings(), defaultScraper: 'MetaTube' } as Record<string, unknown>
    delete legacy.scraperServiceConfigs
    fs.writeFileSync(path.join(tempRoot!, 'settings.json'), JSON.stringify(legacy), 'utf8')
    resetSettingsCacheForTests()

    const normalized = getSettings()
    assert.deepEqual(normalized.scraperServiceConfigs.metatube, {
      serverUrl: '',
      useScrapeProxy: false
    })
    assert.equal(normalized.defaultScraper, 'JavDB')
  })

  it('normalizes origins and path prefixes while rejecting unsafe base URLs', () => {
    assert.equal(
      normalizeScraperServiceServerUrl(' https://example.test/meta/ '),
      'https://example.test/meta'
    )
    assert.equal(normalizeScraperServiceServerUrl('http://[::1]:8080/'), 'http://[::1]:8080')
    assert.throws(() => normalizeScraperServiceServerUrl('ftp://example.test'), /HTTP/)
    assert.throws(() => normalizeScraperServiceServerUrl('https://user@example.test'), /用户名/)
    assert.throws(() => normalizeScraperServiceServerUrl('https://example.test/?x=1'), /查询参数/)
    assert.throws(() => normalizeScraperServiceServerUrl('https://example.test/#x'), /片段/)
  })

  it('stores only public configuration in settings and requires acknowledgement for remote HTTP tokens', () => {
    assert.throws(
      () => saveScraperServiceConfig('metatube', {
        serverUrl: 'http://example.test',
        useScrapeProxy: false,
        tokenUpdate: { mode: 'set', value: 'secret-token' }
      }),
      /明文传输/
    )

    const saved = saveScraperServiceConfig('metatube', {
      serverUrl: 'http://example.test/base/',
      useScrapeProxy: false,
      tokenUpdate: { mode: 'set', value: 'secret-token' },
      acknowledgeInsecureHttp: true
    })
    assert.equal(saved.serverUrl, 'http://example.test/base')
    assert.equal(saved.hasToken, true)
    assert.equal(getScraperServiceToken('metatube'), 'secret-token')
    assert.equal(
      fs.readFileSync(path.join(tempRoot!, 'settings.json'), 'utf8').includes('secret-token'),
      false
    )
  })

  it('blocks clearing while MetaTube is referenced and clears address plus token otherwise', () => {
    saveScraperServiceConfig('metatube', {
      serverUrl: 'http://127.0.0.1:8080',
      useScrapeProxy: false,
      tokenUpdate: { mode: 'set', value: 'secret-token' }
    })
    updateSettings({ defaultScraper: 'MetaTube' })
    assert.throws(() => clearScraperServiceConfig('metatube'), /默认影片刮削源/)

    updateSettings({ defaultScraper: 'JavDB' })
    updateSettings({
      compositeScrapers: {
        video: [{
          kind: 'video',
          name: 'MetaTube metadata',
          fieldPluginMap: { title: 'MetaTube', publisher: 'MetaTube' }
        }],
        actress: []
      }
    })
    assert.throws(
      () => clearScraperServiceConfig('metatube'),
      /组合「MetaTube metadata」字段：title、publisher/
    )
    updateSettings({ compositeScrapers: { video: [], actress: [] } })
    clearScraperServiceConfig('metatube')
    assert.equal(getScraperServicePublicConfig('metatube').serverUrl, '')
    assert.equal(getScraperServiceToken('metatube'), '')
  })

  it('keeps bearer credentials on the configured origin and preserves a base path', async () => {
    updateSettings({
      proxyUrl: 'http://127.0.0.1:7890',
      proxyUrlEnabled: true,
      scraperServiceConfigs: {
        metatube: { serverUrl: 'https://example.test/meta', useScrapeProxy: true }
      }
    })
    saveScraperServiceConfig('metatube', {
      serverUrl: 'https://example.test/meta',
      useScrapeProxy: true,
      tokenUpdate: { mode: 'set', value: 'secret-token' }
    })
    const requests: ScraperServiceTransportRequest[] = []
    setScraperServiceTransportForTests(async (request) => {
      requests.push(request)
      if (requests.length === 1) {
        return json(302, {}, { location: '/meta/final' })
      }
      return json(200, { data: { ok: true } })
    })

    const client = createConfiguredScraperServiceClient('metatube')
    assert.deepEqual(await client.getJson('/v1/test', { query: { q: 'ABC-123' } }), {
      data: { ok: true }
    })
    assert.equal(requests[0]?.url, 'https://example.test/meta/v1/test?q=ABC-123')
    assert.equal(requests[1]?.url, 'https://example.test/meta/final')
    assert.equal(requests.every((request) => request.headers.Authorization === 'Bearer secret-token'), true)
    assert.equal(requests.every((request) => request.proxyUrl === 'http://127.0.0.1:7890'), true)
    assert.equal(requests.every((request) => request.maxBytes === 2 * 1024 * 1024), true)
  })

  it('snapshots the address, proxy choice, and token for an in-flight scrape', async () => {
    saveScraperServiceConfig('metatube', {
      serverUrl: 'https://first.test/base',
      useScrapeProxy: false,
      tokenUpdate: { mode: 'set', value: 'first-token' }
    })
    const requests: ScraperServiceTransportRequest[] = []
    setScraperServiceTransportForTests(async (request) => {
      requests.push(request)
      return json(200, { data: { ok: true } })
    })
    const snapshot = createConfiguredScraperServiceClient('metatube')

    saveScraperServiceConfig('metatube', {
      serverUrl: 'https://second.test/next',
      useScrapeProxy: true,
      tokenUpdate: { mode: 'set', value: 'second-token' }
    })
    await snapshot.getJson('/v1/test')

    assert.equal(requests[0]?.url, 'https://first.test/base/v1/test')
    assert.equal(requests[0]?.headers.Authorization, 'Bearer first-token')
    assert.equal(requests[0]?.proxyUrl, undefined)
  })

  it('rejects cross-origin redirects before sending credentials to the target', async () => {
    updateSettings({
      scraperServiceConfigs: {
        metatube: { serverUrl: 'https://example.test/meta', useScrapeProxy: false }
      }
    })
    const requests: ScraperServiceTransportRequest[] = []
    setScraperServiceTransportForTests(async (request) => {
      requests.push(request)
      return json(302, {}, { location: 'https://evil.test/steal' })
    })

    await assert.rejects(
      () => createConfiguredScraperServiceClient('metatube').getJson('/v1/test'),
      (error: unknown) => error instanceof ScraperServiceError && error.code === 'REDIRECT_BLOCKED'
    )
    assert.equal(requests.length, 1)
  })

  it('rejects HTTPS downgrade redirects', async () => {
    updateSettings({
      scraperServiceConfigs: {
        metatube: { serverUrl: 'https://example.test/meta', useScrapeProxy: false }
      }
    })
    setScraperServiceTransportForTests(async () =>
      json(302, {}, { location: 'http://example.test/meta/insecure' })
    )
    await assert.rejects(
      () => createConfiguredScraperServiceClient('metatube').getJson('/v1/test'),
      (error: unknown) => error instanceof ScraperServiceError && error.code === 'REDIRECT_BLOCKED'
    )
  })

  it('classifies authentication, rate-limit, server, malformed, and oversized responses', async () => {
    updateSettings({
      scraperServiceConfigs: {
        metatube: { serverUrl: 'https://example.test', useScrapeProxy: false }
      }
    })
    for (const [status, code] of [
      [401, 'AUTH'],
      [429, 'RATE_LIMITED'],
      [503, 'SERVER_ERROR']
    ] as const) {
      setScraperServiceTransportForTests(async () => json(status, { error: { message: 'fixture' } }))
      await assert.rejects(
        () => createConfiguredScraperServiceClient('metatube').getJson('/v1/test'),
        (error: unknown) => error instanceof ScraperServiceError && error.code === code
      )
    }

    setScraperServiceTransportForTests(async () => ({
      statusCode: 200,
      headers: {},
      body: Buffer.from('<html>not json</html>', 'utf8')
    }))
    await assert.rejects(
      () => createConfiguredScraperServiceClient('metatube').getJson('/v1/test'),
      (error: unknown) =>
        error instanceof ScraperServiceError && error.code === 'INCOMPATIBLE_RESPONSE'
    )

    setScraperServiceTransportForTests(async () => ({
      statusCode: 200,
      headers: {},
      body: Buffer.alloc(2 * 1024 * 1024 + 1, 0x20)
    }))
    await assert.rejects(
      () => createConfiguredScraperServiceClient('metatube').getJson('/v1/test'),
      (error: unknown) => error instanceof ScraperServiceError && error.code === 'RESPONSE_TOO_LARGE'
    )
  })

  it('tests draft configuration without persisting its token', async () => {
    const requests: ScraperServiceTransportRequest[] = []
    setScraperServiceTransportForTests(async (request) => {
      requests.push(request)
      const url = new URL(request.url)
      if (url.pathname === '/custom/') {
        return json(200, { data: { app: 'metatube', version: 'v1.4.0' } })
      }
      if (url.pathname === '/custom/v1/providers') {
        return json(200, { data: { movie_providers: { FANZA: 'https://example.test' } } })
      }
      if (url.pathname === '/custom/v1/db/version') {
        return json(200, { data: { version: 42 } })
      }
      return json(404, { error: { code: 404, message: 'not found' } })
    })

    const result = await testScraperServiceConnection('metatube', {
      serverUrl: 'https://server.test/custom',
      useScrapeProxy: false,
      tokenUpdate: { mode: 'set', value: 'draft-token' }
    })
    assert.deepEqual(result, {
      app: 'metatube',
      version: 'v1.4.0',
      dbVersion: '42',
      movieProviderCount: 1
    })
    assert.equal(requests.every((request) => request.headers.Authorization === 'Bearer draft-token'), true)
    assert.equal(requests.every((request) => request.timeoutMs === 10_000), true)
    assert.equal(getScraperServiceToken('metatube'), '')
    assert.equal(getSettings().scraperServiceConfigs.metatube.serverUrl, '')
  })
})
