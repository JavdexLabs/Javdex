import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CARD_PAGE_BYTE_LIMIT, toActressCardPage, toScopedVideoCardPage,
  type ActressCard, type ScopedVideoCard
} from './cardProjection'

const video = {
  id: 71, code: 'AB-001\u0000原始', title: '标题', cover_path: '/original/封面.jpg',
  scraped_status: 1, resource_kinds: ['local'], has_pending_scrape: true,
  preferredLibraryId: 9, membershipAddedAt: '2026-01-01',
  libraries: [{ libraryId: 9, name: '原始库名', icon: 'library', color: 'slate' }]
} satisfies ScopedVideoCard
const actress = {
  id: 32, main_name: '完整姓名'.repeat(100), avatar_path: '/original/avatar.jpg',
  gender: 'female', scraped_status: 1, video_count: 29, avatar_fingerprint: 'fp', revision: 7
} satisfies ActressCard

test('runtime allowlists remove long metadata without changing source or route/action identities', () => {
  const long = '资料'.repeat(1024 * 1024)
  const source = { ...video, summary: long, original_title: long, poster_path: long }
  const result = toScopedVideoCardPage({ total: 190, items: [source] })
  assert.deepEqual(result, { total: 190, items: [video] })
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024)
  assert.equal(source.summary, long)
  assert.equal(result.items[0].id, 71)
  assert.equal(result.items[0].preferredLibraryId, 9)
  result.items[0].libraries[0].name = 'changed'
  result.items[0].resource_kinds?.pop()
  assert.equal(source.libraries[0].name, '原始库名')
  assert.deepEqual(source.resource_kinds, ['local'])
})

test('actress cache drops crop/profile/source metadata and preserves face identity and counts', () => {
  const long = 'x'.repeat(2 * CARD_PAGE_BYTE_LIMIT)
  const source = { ...actress, profile_summary: long, avatar_crop_json: long, avatar_source_path: long }
  const statusCounts = { all: 125, success: 80, failed: 5, unscraped: 40 }
  const result = toActressCardPage({ items: [source], total: 125, statusCounts })
  assert.deepEqual(result.items, [actress])
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2048)
  result.statusCounts.success = 0
  assert.equal(statusCounts.success, 80)
  assert.equal(source.avatar_crop_json, long)
})

test('budget counts encoded Unicode and rejects retained oversized fields without truncating identity', () => {
  const source = { ...video, code: '中'.repeat(CARD_PAGE_BYTE_LIMIT / 2) }
  assert.throws(() => toScopedVideoCardPage({ total: 1, items: [source] }), /1 MiB/)
  assert.equal(source.code.length, CARD_PAGE_BYTE_LIMIT / 2)
  assert.throws(() => toActressCardPage({
    total: 1, statusCounts: { all: 1, success: 1, failed: 0, unscraped: 0 },
    items: [{ ...actress, avatar_path: 'a'.repeat(CARD_PAGE_BYTE_LIMIT) }]
  }), /1 MiB/)
})
