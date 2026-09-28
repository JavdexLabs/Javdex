import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { CatalogBackend } from './catalogBackend'
import { removePlayedWatchLater } from './watchLaterPlayback'

it('only removes a queued video when the watch-later option is enabled', async () => {
  let enabled = 0
  let contains = true
  const removals: unknown[] = []
  const backend = { mode: 'local', playlists: {
    listForVideo: async () => [{ id: 3, system_kind: 'watch_later', remove_after_play: enabled, contains_video: contains, generation: 1, revision: 2 }],
    removeVideo: async (input: unknown) => { removals.push(input); return true }
  } } as unknown as CatalogBackend
  await removePlayedWatchLater(backend, 8)
  assert.equal(removals.length, 0)
  enabled = 1
  await removePlayedWatchLater(backend, 8)
  assert.deepEqual(removals, [{ playlistId: 3, videoId: 8 }])
  contains = false
  await removePlayedWatchLater(backend, 8)
  assert.equal(removals.length, 1)
})
