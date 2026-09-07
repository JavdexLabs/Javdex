import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { XMLParser } from 'fast-xml-parser'
import { NFO_EXPORT_PROFILE_IDS } from '@shared/nfoExportTypes'
import {
  coverBasename,
  listUnrepresentedNfoFields,
  renderNfoExportDocument,
  type NfoExportVideoDocument
} from './nfoExportProfiles'
import { parseNfoArtifact } from '../nfoArtifactCodec'

const document: NfoExportVideoDocument = {
  code: 'ABP-123',
  title: 'Title & More',
  originalTitle: 'Original',
  summary: 'Plot <safe>',
  releaseDate: '2025-01-02',
  maker: 'Maker',
  publisher: 'Publisher',
  series: 'Series',
  director: 'Director',
  durationSeconds: 5401,
  tags: ['Drama', 'Drama', 'Action'],
  actors: [{ name: 'Alice', gender: 'female', thumbReference: '.actors/Alice.jpg' }],
  ratings: [
    { source: 'javdb', average: 4.5, count: 10 },
    { source: 'imdb', average: 4.25, count: 20 }
  ],
  identities: [{ source: 'imdb', code: 'tt123' }, { source: 'unregistered-site', code: 'private' }],
  coverReference: 'ABP-123-poster.jpg',
  landscapeReference: 'ABP-123-landscape.jpg',
  fanartReference: 'ABP-123-fanart.png'
}

describe('NFO export profiles', () => {
  it('renders all public profiles as valid movie XML without database identities', () => {
    const parser = new XMLParser({ ignoreAttributes: false })
    for (const profileId of NFO_EXPORT_PROFILE_IDS) {
      const rendered = renderNfoExportDocument(profileId, document).toString('utf8')
      const parsed = parser.parse(rendered) as { movie?: Record<string, unknown> }
      assert.ok(parsed.movie, profileId)
      assert.match(rendered, /ABP-123/u)
      assert.doesNotMatch(rendered, /video_id|database_id|user_rating/iu)
      assert.doesNotMatch(rendered, /unregistered-site|private/iu)
      const fixture = fs.readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', `${profileId}.nfo`),
        'utf8'
      ).replace(/\r\n/gu, '\n').replace(/\n+$/u, '\n')
      assert.equal(rendered, fixture, `${profileId} golden output changed`)
      const roundTrip = parseNfoArtifact(Buffer.from(rendered))
      assert.equal(roundTrip.model.code, document.code)
      assert.equal(roundTrip.model.title, document.title)
    }
  })

  it('applies profile-specific conservative fields and keeps background separate from samples', () => {
    const portable = renderNfoExportDocument('portable-v1', document).toString('utf8')
    const plex = renderNfoExportDocument('plex-nfo-1.43.1+', document).toString('utf8')
    const infuse = renderNfoExportDocument('infuse-current', document).toString('utf8')
    assert.match(portable, /<gender>female<\/gender>/u)
    assert.match(portable, /<thumb>ABP-123-fanart.png<\/thumb>/u)
    assert.doesNotMatch(portable, /extrafanart|javdex-samples/u)
    assert.doesNotMatch(plex, /extrafanart/u)
    assert.match(portable, /<thumb aspect="landscape">ABP-123-landscape.jpg<\/thumb>/u)
    assert.doesNotMatch(plex, /landscape/u)
    assert.doesNotMatch(infuse, /landscape/u)
    assert.match(plex, /<rating name="imdb"/u)
    assert.doesNotMatch(plex, /<rating name="javdb"/u)
    assert.doesNotMatch(infuse, /<ratings>/u)
    assert.equal(coverBasename('portable-v1', 'ABP-123'), 'ABP-123-poster')
    assert.equal(coverBasename('infuse-current', 'ABP-123'), 'ABP-123')
  })

  it('canonicalizes and deduplicates Plex rating source aliases', () => {
    const plex = renderNfoExportDocument('plex-nfo-1.43.1+', {
      ...document,
      ratings: [
        { source: ' TVDB ', average: 3.5 },
        { source: ' IMDb ', average: 4.25, count: 20 },
        { source: 'imdb', average: 1, count: 1 },
        { source: 'TMDB', average: 4 },
        { source: 'themoviedb', average: 2 }
      ]
    }).toString('utf8')

    assert.deepEqual(
      Array.from(plex.matchAll(/<rating name="([^"]+)"/gu), (match) => match[1]),
      ['imdb', 'themoviedb', 'thetvdb']
    )
    assert.match(plex, /<rating name="imdb"[^>]*>[\s\S]*?<value>4\.25<\/value>/u)
    assert.doesNotMatch(plex, /<value>1<\/value>/u)
    assert.doesNotMatch(plex, /<value>2<\/value>/u)
  })

  it('reports populated fields that the selected profile cannot represent', () => {
    assert.deepEqual(listUnrepresentedNfoFields('portable-v1', document), ['站点身份'])
    assert.deepEqual(listUnrepresentedNfoFields('emby-kodi-conservative', document), [
      '发行方', '评分', '演员性别', '站点身份'
    ])
    assert.deepEqual(listUnrepresentedNfoFields('plex-nfo-1.43.1+', document), [
      '发行方', '评分', '演员性别', '站点身份'
    ])
    assert.deepEqual(listUnrepresentedNfoFields('infuse-current', document), [
      '原始标题', '发行方', '评分', '演员性别', '站点身份'
    ])
  })
})
