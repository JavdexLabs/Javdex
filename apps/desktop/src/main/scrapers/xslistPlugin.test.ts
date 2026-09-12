import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runUserActressPlugin } from './scraperPluginSandbox'
import { scrapeBrowser } from './scrapeBrowser'

const XSLIST_PLUGIN_PATH = path.join(
  process.cwd(),
  'apps/desktop/src/main/bundled-plugins/actress/Xslist/index.cjs'
)

const originalSetProxy = scrapeBrowser.setProxy
const originalFetchPage = scrapeBrowser.fetchPage

afterEach(() => {
  scrapeBrowser.setProxy = originalSetProxy
  scrapeBrowser.fetchPage = originalFetchPage
})

async function scrapeFixture(avatarUrl: string) {
  scrapeBrowser.setProxy = async () => {}
  scrapeBrowser.fetchPage = async (url) => {
    if (url.includes('/search?')) {
      return '<ul class="r"><li class="clearfix"><h3><a href="https://xslist.org/zh/model/test-actress">Test Actress</a></h3></li></ul>'
    }
    return `
      <div id="layout">
        <h1><span itemprop="name">Test Actress</span></h1>
        <div class="profile_img_c"><img src="${avatarUrl}"></div>
        <p>Fixture profile content for the bundled Xslist actress scraper.</p>
      </div>
    `
  }

  return runUserActressPlugin(
    'Xslist',
    fs.readFileSync(XSLIST_PLUGIN_PATH, 'utf8'),
    'Test Actress',
    []
  )
}

describe('Xslist bundled actress plugin', () => {
  it('treats the site anonymous image as no avatar', async () => {
    const result = await scrapeFixture('https://xslist.org/assets/images/anonymous2.png')

    assert.equal(result?.avatarUrl, undefined)
  })

  it('keeps a real profile avatar', async () => {
    const result = await scrapeFixture('https://xslist.org/uploads/test-actress.jpg')

    assert.equal(result?.avatarUrl, 'https://xslist.org/uploads/test-actress.jpg')
  })
})
