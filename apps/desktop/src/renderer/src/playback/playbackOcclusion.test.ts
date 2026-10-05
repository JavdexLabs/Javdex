import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasPlaybackOcclusion, playbackOcclusions } from './playbackOcclusion'

const video = { left: 0, top: 0, right: 100, bottom: 100 }
function surface(bounds: typeof video, visible = true) {
  return {
    getBoundingClientRect: () => bounds,
    checkVisibility: (options?: CheckVisibilityOptions) => {
      assert.deepEqual(options, { checkOpacity: true, checkVisibilityCSS: true })
      return visible
    }
  }
}
test('only positive-area intersections with visible occluders hide native video', () => {
  assert.equal(hasPlaybackOcclusion(video, []), false)
  assert.equal(hasPlaybackOcclusion(video, [surface({ left: 99, top: 99, right: 150, bottom: 150 })]), true)
  assert.equal(hasPlaybackOcclusion(video, [surface({ left: -10, top: -10, right: 10, bottom: 10 })]), true)
  for (const bounds of [
    { left: 100, top: 0, right: 150, bottom: 50 },
    { left: 0, top: 100, right: 50, bottom: 150 },
    { left: -50, top: 0, right: 0, bottom: 50 },
    { left: 0, top: -50, right: 50, bottom: 0 },
    { left: 20, top: 20, right: 20, bottom: 30 },
    { left: 20, top: 20, right: 30, bottom: 20 }
  ]) assert.equal(hasPlaybackOcclusion(video, [surface(bounds)]), false)
  assert.equal(hasPlaybackOcclusion(video, [surface(video, false)]), false)
  assert.equal(hasPlaybackOcclusion(video, [surface(video, false), surface(video)]), true)
  assert.equal(hasPlaybackOcclusion({ ...video, right: 0 }, [surface(video)]), false)
})
test('popup cutouts contain only their intersection with the video', () => {
  assert.deepEqual(playbackOcclusions(video, [surface({ left: 80, top: 70, right: 160, bottom: 120 }),
    surface({ left: -20, top: -30, right: 20, bottom: 10 }), surface(video, false)]),
  [{ x: 80, y: 70, width: 20, height: 30 }, { x: 0, y: 0, width: 20, height: 10 }])
})
