import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import { setScraperServiceSecretCipherForTests } from '../settings/scraperServiceSecretStore'
import {
  saveScraperServiceConfig,
  setScraperServiceTransportForTests,
  testScraperServiceConnection
} from './configuredScraperService'
import { runUserVideoPlugin } from './scraperPluginSandbox'

let tempRoot: string | null = null
let previousUserData: string | undefined
let server: http.Server | null = null

function listen(serverToStart: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    serverToStart.once('error', reject)
    serverToStart.listen(0, '127.0.0.1', () => {
      const address = serverToStart.address()
      if (!address || typeof address === 'string') {
        reject(new Error('fixture server did not expose a TCP port'))
        return
      }
      resolve(address.port)
    })
  })
}

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-metatube-integration-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  setScraperServiceSecretCipherForTests({
    state: () => ({ protection: 'secure', backend: 'test' }),
    encrypt: (value) => Buffer.from([...value].reverse().join(''), 'utf8'),
    decrypt: (value) => [...value.toString('utf8')].reverse().join('')
  })
  setScraperServiceTransportForTests(null)
  resetSettingsCacheForTests()
})

afterEach(async () => {
  setScraperServiceTransportForTests(null)
  setScraperServiceSecretCipherForTests(null)
  resetSettingsCacheForTests()
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve()))
    )
  }
  server = null
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('MetaTube service integration', () => {
  it('runs connection checks and the bundled worker against a local fake HTTP service', async () => {
    const authorizationHeaders: Array<string | undefined> = []
    server = http.createServer((request, response) => {
      authorizationHeaders.push(request.headers.authorization)
      const url = new URL(request.url ?? '/', 'http://fixture.test')
      let body: unknown
      if (url.pathname === '/meta/') {
        body = { data: { app: 'metatube', version: 'v1.4.0' } }
      } else if (url.pathname === '/meta/v1/providers') {
        body = { data: { movie_providers: { Fixture: 'Fixture' } } }
      } else if (url.pathname === '/meta/v1/db/version') {
        body = { data: { version: 7 } }
      } else if (url.pathname === '/meta/v1/movies/search') {
        body = { data: [{ provider: 'Fixture', id: 'movie-1', number: 'ABC-123' }] }
      } else if (url.pathname === '/meta/v1/movies/Fixture/movie-1') {
        body = {
          data: {
            provider: 'Fixture',
            id: 'movie-1',
            number: 'ABC-123',
            title: 'Local integration result',
            actors: ['Alice']
          }
        }
      } else {
        response.writeHead(404, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'not found' } }))
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    })
    const port = await listen(server)
    const serverUrl = `http://127.0.0.1:${port}/meta`
    setScraperServiceTransportForTests(async (request) => {
      assert.equal(request.proxyUrl, undefined)
      const response = await fetch(request.url, {
        headers: request.headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(request.timeoutMs)
      })
      return {
        statusCode: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: Buffer.from(await response.arrayBuffer())
      }
    })
    saveScraperServiceConfig('metatube', {
      serverUrl,
      useScrapeProxy: false,
      tokenUpdate: { mode: 'set', value: 'fixture-token' }
    })

    const connection = await testScraperServiceConnection('metatube', {
      serverUrl,
      useScrapeProxy: false,
      tokenUpdate: { mode: 'keep' }
    })
    assert.deepEqual(connection, {
      app: 'metatube',
      version: 'v1.4.0',
      dbVersion: '7',
      movieProviderCount: 1
    })

    const pluginCode = fs.readFileSync(
      path.join(process.cwd(), 'src/main/bundled-plugins/video/MetaTube/index.cjs'),
      'utf8'
    )
    const result = await runUserVideoPlugin(
      'MetaTube',
      pluginCode,
      'ABC-123',
      undefined,
      'metatube'
    )
    assert.equal(Array.isArray(result), true)
    assert.equal(Array.isArray(result) ? result[0]?.title : undefined, 'Local integration result')
    assert.deepEqual(
      Array.isArray(result) ? result[0]?.actresses : undefined,
      [{ name: 'Alice', gender: 'female' }]
    )
    assert.equal(authorizationHeaders.length, 5)
    assert.equal(authorizationHeaders.every((value) => value === 'Bearer fixture-token'), true)
  })
})
