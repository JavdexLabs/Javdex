import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MediaLibraryDetail } from '@shared/mediaLibraryTypes'
import { resolveVideoDetailDefaultScraper } from './videoDetailScraperState'

function library(id: number, defaultVideoScraper: string | null) {
  return {
    id,
    config: { defaultVideoScraper }
  } as Pick<MediaLibraryDetail, 'id' | 'config'>
}

describe('video detail scraper selection', () => {
  it('prefers the active media-library default over the global default', () => {
    assert.equal(
      resolveVideoDetailDefaultScraper(2, library(2, ' Library Scraper '), 'Global Scraper'),
      'Library Scraper'
    )
  })

  it('does not retain the previous library default when the active library switches', () => {
    const previousLibrary = library(2, 'Library Two')
    assert.equal(
      resolveVideoDetailDefaultScraper(3, previousLibrary, 'Global Scraper'),
      'Global Scraper'
    )
    assert.equal(
      resolveVideoDetailDefaultScraper(3, library(3, 'Library Three'), 'Global Scraper'),
      'Library Three'
    )
  })

  it('falls back to the global default when the active library has no override', () => {
    assert.equal(
      resolveVideoDetailDefaultScraper(2, library(2, null), ' Global Scraper '),
      'Global Scraper'
    )
  })
})
