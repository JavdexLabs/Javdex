import assert from 'node:assert/strict'
import { it } from 'node:test'
import { playlistBrowseItemSchema } from './playlistSchemas'

const legacy = { id: 1, name: '我喜欢', description: null, preview_cover_path: 'covers/first.jpg', video_count: 1, contains_video: false }

it('retains cover origin and built-in identity across parsed playlist browse responses', () => {
  for (const system_kind of ['favorites', 'watch_later', null]) {
    const input = { ...legacy, system_kind, cover_path: 'playlist_covers/custom.png' }
    assert.deepEqual(playlistBrowseItemSchema.parse(input), input)
  }
  assert.equal(playlistBrowseItemSchema.safeParse({ ...legacy, system_kind: 'unknown' }).success, false)
})

it('continues to accept older browse responses without the optional cover fields', () => {
  assert.deepEqual(playlistBrowseItemSchema.parse(legacy), legacy)
})
