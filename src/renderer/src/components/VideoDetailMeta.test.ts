import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { VideoDetail } from '@shared/videoTypes'
import { buildVideoPrimaryMetaItems } from './VideoDetailMeta'

function video(overrides: Partial<VideoDetail>): VideoDetail {
  return {
    id: 1,
    code: 'TEST-001',
    title: null,
    original_title: null,
    summary: null,
    cover_path: null,
    poster_path: null,
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
    resolved_duration_seconds: null,
    scraped_status: 0,
    last_scraped_at: null,
    updated_at: null,
    add_time: '2026-01-01T00:00:00.000Z',
    rating: 0,
    actresses: [],
    tags: [],
    resources: [],
    assets: [],
    external_stats: [],
    ...overrides
  }
}

describe('video primary metadata classification navigation', () => {
  it('dispatches entity-backed organizations by stable id', () => {
    const items = buildVideoPrimaryMetaItems(
      video({
        maker: 'Renamed Maker',
        maker_organization_id: 12,
        publisher: 'Publisher',
        publisher_organization_id: 18
      })
    )

    assert.deepEqual(items, [
      {
        key: 'maker',
        label: '制作商',
        type: 'organization',
        role: 'maker',
        organizationId: 12,
        value: 'Renamed Maker'
      },
      {
        key: 'publisher',
        label: '发行商',
        type: 'organization',
        role: 'publisher',
        organizationId: 18,
        value: 'Publisher'
      }
    ])
  })

  it('keeps a legacy text route only while an organization id is absent', () => {
    assert.deepEqual(buildVideoPrimaryMetaItems(video({ maker: 'Legacy Maker' })), [
      {
        key: 'maker',
        label: '制作商',
        type: 'facet',
        facet: 'maker',
        value: 'Legacy Maker'
      }
    ])
  })
})
