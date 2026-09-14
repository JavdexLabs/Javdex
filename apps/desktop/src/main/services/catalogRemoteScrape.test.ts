import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ActressDetail } from '@shared/actressTypes'
import type { VideoDetail } from '@shared/videoTypes'
import {
  resolveEffectiveFromActressDetail,
  resolveEffectiveFromVideoDetail
} from './catalogRemoteScrape'

function video(overrides: Partial<VideoDetail> = {}): VideoDetail {
  return {
    id: 1,
    code: 'C6-001',
    title: null,
    summary: null,
    cover_path: null,
    poster_path: null,
    original_title: null,
    rating: 0,
    release_date: null,
    maker: null,
    publisher: null,
    maker_organization_id: null,
    publisher_organization_id: null,
    series: null,
    director: null,
    series_id: null,
    director_id: null,
    duration_seconds: null,
    scraped_status: 0,
    last_scraped_at: null,
    updated_at: null,
    add_time: '2026',
    resources: [],
    actresses: [],
    tags: [],
    assets: [],
    external_stats: [],
    links: [],
    ...overrides
  }
}

function actress(overrides: Partial<ActressDetail> = {}): ActressDetail {
  return {
    id: 1,
    main_name: 'One',
    avatar_path: null,
    avatar_source_path: null,
    avatar_crop_json: null,
    poster_path: null,
    birth_date: null,
    debut_date: null,
    height_cm: null,
    bust_cm: null,
    waist_cm: null,
    hip_cm: null,
    cup_size: null,
    blood_type: null,
    zodiac: null,
    nationality: null,
    profile_summary: null,
    scraped_status: 0,
    last_scraped_at: null,
    updated_at: null,
    gender: 'female',
    name_zh: null,
    name_en: null,
    aliases: [],
    names: [],
    gallery: [],
    videos: [],
    links: [],
    ...overrides
  }
}

describe('catalog remote scrape field selection', () => {
  it('keeps requested fields for replace and drops filled fields for fillEmpty', () => {
    const filled = video({
      title: 'Has title',
      cover_path: 'covers/a.jpg',
      actresses: [{ gender: 'female' } as VideoDetail['actresses'][number]]
    })
    assert.deepEqual(
      resolveEffectiveFromVideoDetail(filled, ['title', 'summary', 'cover'], 'replace'),
      ['title', 'summary', 'cover']
    )
    assert.deepEqual(
      resolveEffectiveFromVideoDetail(filled, ['title', 'summary', 'cover'], 'fillEmpty'),
      ['summary']
    )
    assert.deepEqual(
      resolveEffectiveFromVideoDetail(video(), ['title', 'source'], 'fillEmpty', 'Site'),
      ['title', 'source']
    )
    assert.deepEqual(
      resolveEffectiveFromVideoDetail(
        video({ links: [{ label: 'Site', url: 'https://example.test/a', position: 0 }] }),
        ['title', 'source'],
        'fillEmpty',
        'Site'
      ),
      ['title']
    )
  })

  it('treats a present actress avatar path as filled for remote fillEmpty', () => {
    assert.deepEqual(
      resolveEffectiveFromActressDetail(actress({ avatar_path: 'avatars/a.jpg' }), ['avatar', 'nameZh'], 'fillEmpty'),
      ['nameZh']
    )
    assert.deepEqual(
      resolveEffectiveFromActressDetail(actress(), ['avatar', 'nameZh'], 'replace'),
      ['avatar', 'nameZh']
    )
  })
})
