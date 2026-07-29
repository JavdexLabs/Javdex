import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  runUserActressPlugin,
  setSandboxBufferFetcherForTests,
  validateUserPluginCode
} from './scraperPluginSandbox'

const CHEERIO_PLUGIN = `
module.exports = {
  async parseVideo(ctx) {
    const $ = ctx.cheerio.load('<div class="title">ok</div>');
    return { code: ctx.code, title: $('.title').text() };
  }
};
`

describe('scraperPluginSandbox', () => {
  it('loads cheerio inside eval worker via app-root createRequire', async () => {
    await validateUserPluginCode('video', 'cheerio-test', CHEERIO_PLUGIN)
    assert.ok(true)
  })

  it('serves repeated persistent fetchBuffer calls from the plugin resource cache', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-sandbox-cache-'))
    const previousUserData = process.env.JAVDEX_TEST_USER_DATA
    process.env.JAVDEX_TEST_USER_DATA = userData
    let requests = 0
    const server = http.createServer((_request, response) => {
      requests += 1
      response.writeHead(200, { ETag: '"fixture-v1"' })
      response.end('cached-body')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const url = `http://127.0.0.1:${address.port}/resource`
    const plugin = `
module.exports = {
  async parseActress(ctx) {
    const options = {
      cache: { mode: 'persistent', maxAgeMs: 60000, staleIfError: true }
    };
    const first = await ctx.fetchBuffer(${JSON.stringify(url)}, options);
    const second = await ctx.fetchBuffer(${JSON.stringify(url)}, options);
    return { profileSummary: first.toString() + ':' + second.toString() };
  }
};
`

    try {
      setSandboxBufferFetcherForTests(async (resourceUrl, _proxyUrl, headers) => {
        const response = await fetch(resourceUrl, { headers })
        return {
          statusCode: response.status,
          body: Buffer.from(await response.arrayBuffer()),
          etag: response.headers.get('etag') ?? undefined
        }
      })
      const result = await runUserActressPlugin(
        'persistent-fetch-integration',
        plugin,
        'Test Actress',
        []
      )
      assert.equal(result?.profileSummary, 'cached-body:cached-body')
      assert.equal(requests, 1)
    } finally {
      setSandboxBufferFetcherForTests()
      if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
      else process.env.JAVDEX_TEST_USER_DATA = previousUserData
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
      fs.rmSync(userData, { recursive: true, force: true })
    }
  })
})
