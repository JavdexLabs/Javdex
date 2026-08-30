import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Video } from '@shared/videoTypes'
import { matchesPlaylistResourceFilter } from './playlistResourceFilter'

function video(resourceKinds: Video['resource_kinds']): Video {
  return { id: 1, code: 'TEST-1', scraped_status: 0, resource_kinds: resourceKinds } as Video
}

describe('matchesPlaylistResourceFilter', () => {
  it('uses OR semantics and treats none as global zero resources', () => {
    assert.equal(matchesPlaylistResourceFilter(video(['local', 'web']), []), true)
    assert.equal(matchesPlaylistResourceFilter(video(['local', 'web']), ['web']), true)
    assert.equal(matchesPlaylistResourceFilter(video(['local', 'web']), ['direct', 'web']), true)
    assert.equal(matchesPlaylistResourceFilter(video(['local']), ['direct', 'web']), false)
    assert.equal(matchesPlaylistResourceFilter(video([]), ['none']), true)
    assert.equal(matchesPlaylistResourceFilter(video(['magnet']), ['none', 'magnet']), true)
    assert.equal(matchesPlaylistResourceFilter(video([]), ['none', 'magnet']), true)
  })
})
