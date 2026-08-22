import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  prioritizeInspectLinks,
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
