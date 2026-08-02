import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ActressListItem } from '@shared/types'
import {
  cacheActressFaceStatus,
  uncachedActressFaceScanIdentity,
  type ActressFaceScanCache
} from './cache'

function item(id: number, fingerprint: string): ActressListItem {
  return {
    id,
    main_name: `Actress ${id}`,
    avatar_path: `avatars/${id}.jpg`,
    avatar_fingerprint: fingerprint,
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
    gender: null,
    video_count: 0
  }
}

describe('actress face scan cache identity', () => {
  it('only changes when a current row has no reusable result', () => {
    const cache: ActressFaceScanCache = new Map()
    const rows = [item(1, 'fp-a'), item(2, 'fp-b')]
    assert.equal(uncachedActressFaceScanIdentity(rows, cache), '1:fp-a|2:fp-b')

    cacheActressFaceStatus(cache, 1, 'fp-a', 'has-face')
    assert.equal(uncachedActressFaceScanIdentity(rows, cache), '2:fp-b')

    cacheActressFaceStatus(cache, 2, 'fp-b', 'without-face')
    assert.equal(uncachedActressFaceScanIdentity(rows, cache), '')
  })
})
