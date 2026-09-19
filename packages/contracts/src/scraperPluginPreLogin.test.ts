import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  scraperPluginPreLoginAvailable,
  scraperPluginPreLoginHomeUrl
} from './scraperPluginPreLogin'

describe('scraper plugin pre-login homepage', () => {
  it('accepts site homepages and rejects API or GitHub project pages', () => {
    assert.equal(scraperPluginPreLoginHomeUrl('https://javdb.com/'), 'https://javdb.com/')
    assert.equal(
      scraperPluginPreLoginHomeUrl('https://www.javlibrary.com'),
      'https://www.javlibrary.com/'
    )
    assert.equal(scraperPluginPreLoginHomeUrl('https://xslist.org'), 'https://xslist.org/')
    assert.equal(
      scraperPluginPreLoginHomeUrl('https://github.com/metatube-community/metatube-sdk-go'),
      null
    )
    assert.equal(scraperPluginPreLoginHomeUrl('https://github.com/gfriends/gfriends'), null)
    assert.equal(scraperPluginPreLoginHomeUrl('https://gfriends.github.io/'), null)
    assert.equal(scraperPluginPreLoginHomeUrl('not a url'), null)
    assert.equal(
      scraperPluginPreLoginAvailable({
        source: 'builtin',
        homepage: 'https://javdb.com/'
      }),
      true
    )
    assert.equal(
      scraperPluginPreLoginAvailable({
        source: 'builtin',
        requiresConfiguration: true,
        homepage: 'https://javdb.com/'
      }),
      false
    )
    assert.equal(
      scraperPluginPreLoginAvailable({
        source: 'composite',
        homepage: 'https://javdb.com/'
      }),
      false
    )
  })
})
