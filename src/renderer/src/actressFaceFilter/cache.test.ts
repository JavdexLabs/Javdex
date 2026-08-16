import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ActressListItem } from '@shared/actressTypes'
import {
  actressesWithoutFace,
  actressIdsWithoutFace,
  cacheActressFaceStatus,
  getCachedActressFaceStatus,
  type ActressFaceScanCache
} from './cache'

function item(id: number, avatarPath: string): ActressListItem {
  return {
    id,
    main_name: `Actress ${id}`,
    avatar_path: avatarPath,
    avatar_fingerprint: avatarPath,
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

describe('actress face scan cache', () => {
  it('reuses a result only while the avatar fingerprint is unchanged', () => {
    const cache: ActressFaceScanCache = new Map()
    cacheActressFaceStatus(cache, 7, 'fp-a', 'without-face')

    assert.equal(getCachedActressFaceStatus(cache, 7, 'fp-a'), 'without-face')
    assert.equal(getCachedActressFaceStatus(cache, 7, 'fp-b'), null)
  })

  it('filters only cached no-face avatars and ignores missing or unscanned entries', () => {
    const cache: ActressFaceScanCache = new Map()
    cacheActressFaceStatus(cache, 1, 'avatars/a.jpg', 'without-face')
    cacheActressFaceStatus(cache, 2, 'avatars/b.jpg', 'has-face')

    assert.deepEqual(
      actressesWithoutFace(
        [item(1, 'avatars/a.jpg'), item(2, 'avatars/b.jpg'), item(3, 'avatars/c.jpg')],
        cache
      ).map((entry) => entry.id),
      [1]
    )
  })

  it('combines a minimal full-library manifest with current session results', () => {
    const cache: ActressFaceScanCache = new Map()
    cacheActressFaceStatus(cache, 1, 'fp-a', 'without-face')
    cacheActressFaceStatus(cache, 2, 'fp-b', 'has-face')
    cacheActressFaceStatus(cache, 3, 'stale-fingerprint', 'without-face')

    assert.deepEqual(
      actressIdsWithoutFace(
        [
          { id: 1, avatar_fingerprint: 'fp-a' },
          { id: 2, avatar_fingerprint: 'fp-b' },
          { id: 3, avatar_fingerprint: 'changed-fingerprint' },
          { id: 4, avatar_fingerprint: 'fp-d' }
        ],
        cache
      ),
      [1]
    )
  })
})
