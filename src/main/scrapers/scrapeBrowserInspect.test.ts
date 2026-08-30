import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  inspectLinkRawHref,
  prioritizeInspectLinks,
  selectInspectLocaleLinks,
  selectInspectScriptSrcs,
  type InspectLinkCandidate
} from './scrapeBrowserInspect'

function candidate(
  href: string,
  options: Partial<InspectLinkCandidate> = {}
): InspectLinkCandidate {
  return {
    href,
    inContentRegion: false,
    inNavigationRegion: false,
    isLocaleLink: false,
    ...options
  }
}

describe('prioritizeInspectLinks', () => {
  it('keeps a main result card when more than maxLinks navigation links precede it', () => {
    const navigationLinks = Array.from({ length: 65 }, (_, index) =>
      candidate(`https://example.test/nav/${index}`, { inNavigationRegion: true })
    )
    const resultCard = candidate('https://example.test/milk-295', {
      inContentRegion: true
    })

    const links = prioritizeInspectLinks([...navigationLinks, resultCard], 60)

    assert.equal(links.length, 60)
    assert.equal(links[0]?.href, resultCard.href)
    assert.ok(links.some((link) => link.href === resultCard.href))
  })

  it('preserves DOM order within priority groups and deduplicates after prioritizing', () => {
    const links = prioritizeInspectLinks(
      [
        candidate('https://example.test/shared', { inNavigationRegion: true }),
        candidate('https://example.test/content/1', { inContentRegion: true }),
        candidate('https://example.test/other/1'),
        candidate('https://example.test/content/2', { inContentRegion: true }),
        candidate('https://example.test/shared', { inContentRegion: true }),
        candidate('https://example.test/locale', { isLocaleLink: true }),
        candidate('https://example.test/other/2')
      ],
      20
    )

    assert.deepEqual(
      links.map((link) => link.href),
      [
        'https://example.test/content/1',
        'https://example.test/content/2',
        'https://example.test/shared',
        'https://example.test/other/1',
        'https://example.test/other/2',
        'https://example.test/locale'
      ]
    )
    assert.equal(links[2]?.inContentRegion, true)
  })
})

describe('selectInspectLocaleLinks', () => {
  it('keeps locale anchors in document order and always allows an empty result', () => {
    assert.deepEqual(selectInspectLocaleLinks([
      candidate('https://example.test/video/1', { inContentRegion: true }),
      candidate('https://example.test/nav/1', { inNavigationRegion: true })
    ]), [])

    const links = selectInspectLocaleLinks([
      candidate('https://example.test/en', { isLocaleLink: true }),
      candidate('https://example.test/video/1', { inContentRegion: true }),
      candidate('https://example.test/cn', { isLocaleLink: true }),
      candidate('https://example.test/en', { isLocaleLink: true })
    ])
    assert.deepEqual(
      links.map((link) => link.href),
      ['https://example.test/en', 'https://example.test/cn']
    )
  })

  it('caps locale anchors without mixing them back into content ranking', () => {
    const links = selectInspectLocaleLinks(
      Array.from({ length: 40 }, (_, index) =>
        candidate(`https://example.test/lang/${index}`, { isLocaleLink: true })
      ),
      3
    )
    assert.deepEqual(
      links.map((link) => link.href),
      [
        'https://example.test/lang/0',
        'https://example.test/lang/1',
        'https://example.test/lang/2'
      ]
    )
  })
})

describe('selectInspectScriptSrcs', () => {
  it('keeps document order, deduplicates, and allows an empty result', () => {
    assert.deepEqual(selectInspectScriptSrcs([]), [])
    assert.deepEqual(
      selectInspectScriptSrcs([
        { href: 'https://xslist.org/assets/app.js' },
        { href: 'https://xslist.org/assets/jquery.js' },
        { href: 'https://xslist.org/assets/app.js' },
        { href: 'https://xslist.org/assets/search.js', rawHref: '/assets/search.js' }
      ], 3),
      [
        { href: 'https://xslist.org/assets/app.js' },
        { href: 'https://xslist.org/assets/jquery.js' },
        { href: 'https://xslist.org/assets/search.js', rawHref: '/assets/search.js' }
      ]
    )
  })
})

describe('inspectLinkRawHref', () => {
  it('omits rawHref when the HTML attribute already matches the resolved href', () => {
    assert.equal(
      inspectLinkRawHref('https://example.test/en/fns-248', 'https://example.test/en/fns-248'),
      undefined
    )
    assert.equal(inspectLinkRawHref('https://example.test/en/fns-248', '  '), undefined)
  })

  it('keeps protocol-relative and path-only attributes that cheerio will see', () => {
    assert.equal(
      inspectLinkRawHref('https://example.test/en/fns-248', '//example.test/en/fns-248'),
      '//example.test/en/fns-248'
    )
    assert.equal(
      inspectLinkRawHref('https://example.test/en/fns-248', '/en/fns-248'),
      '/en/fns-248'
    )
  })
})
