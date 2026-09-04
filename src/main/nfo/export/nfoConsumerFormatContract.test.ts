import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { XMLParser } from 'fast-xml-parser'
import { coverBasename, renderNfoExportDocument, type NfoExportVideoDocument } from './nfoExportProfiles'

const baselines = {
  jellyfin: '10.11.11',
  emby: '4.9.5.0',
  plex: 'PMS 1.43.1+',
  infuse: '8.5.3',
  nova: '6.4.37'
} as const

const base: NfoExportVideoDocument = {
  code: 'ABC-001',
  title: 'Consumer Smoke',
  summary: 'Structured plot',
  releaseDate: '2026-01-02',
  maker: 'Studio',
  series: 'Set',
  director: 'Director',
  durationSeconds: 3600,
  tags: ['Tag'],
  actors: [{ name: 'Actor' }],
  ratings: [
    { source: 'javdb', average: 4.1, count: 2 },
    { source: 'imdb', average: 4.2, count: 3 }
  ],
  identities: [{ source: 'javdb', code: 'site-id' }],
  sampleReferences: []
}

function movie(profile: Parameters<typeof renderNfoExportDocument>[0], document = base): Record<string, unknown> {
  const xml = renderNfoExportDocument(profile, document).toString('utf8')
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml) as { movie: Record<string, unknown> }
  return parsed.movie
}

describe('consumer format contracts', () => {
  it(`matches the documented Jellyfin ${baselines.jellyfin} NFO field contract`, () => {
    const value = movie('jellyfin-current')
    assert.equal(value.title, 'Consumer Smoke')
    assert.equal(value.plot, 'Structured plot')
    assert.equal(value.genre, 'Tag')
    assert.ok(value.ratings)
  })

  it(`keeps the Emby ${baselines.emby} profile inside the conservative Kodi subset`, () => {
    const value = movie('emby-kodi-conservative')
    assert.equal(value.title, 'Consumer Smoke')
    assert.equal(value.genre, 'Tag')
    assert.equal(value.ratings, undefined)
  })

  it(`matches the published ${baselines.plex} NFO Agent identity and rating contract`, () => {
    const value = movie('plex-nfo-1.43.1+')
    assert.ok(value.uniqueid)
    assert.deepEqual(value.ratings, {
      rating: {
        '@_name': 'imdb',
        '@_max': '5',
        '@_default': 'true',
        value: 4.2,
        votes: 3
      }
    })
    assert.ok(value.set)
  })

  it(`uses the Infuse ${baselines.infuse} same-stem artwork convention`, () => {
    assert.equal(coverBasename('infuse-current', 'ABC-001'), 'ABC-001')
    const value = movie('infuse-current', { ...base, coverReference: 'ABC-001.jpg' })
    assert.equal((value.thumb as { '#text': string })['#text'], 'ABC-001.jpg')
  })

  it(`keeps the portable output within the Nova ${baselines.nova} and generic Kodi parser subset`, () => {
    const value = movie('portable-v1')
    assert.equal(value.title, 'Consumer Smoke')
    assert.equal(value.plot, 'Structured plot')
    assert.ok(value.actor)
    assert.ok(value.set)
  })
})
