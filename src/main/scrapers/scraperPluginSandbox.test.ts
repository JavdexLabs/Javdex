import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateUserPluginCode } from './scraperPluginSandbox'

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
})
