import assert from 'node:assert/strict'
import { test } from 'node:test'
import { meanByteDifference, sampleColorPatches } from './playback-pixel-math.mjs'

test('a three-byte mean difference stays on the inclusive boundary', () => {
  assert.equal(meanByteDifference(161.35999999999999, 164.36), 3)
  assert.equal(meanByteDifference(164.36, 161.35999999999999), 3)
})
test('integer patch sums still reject real tint and phase differences', () => {
  assert.ok(meanByteDifference(185.64, 188.68) > 3)
  assert.ok(meanByteDifference(185.64, 189.36) > 3)
  assert.ok(meanByteDifference(185.64, 189.68) > 4)
})

test('Canvas RGBA and compositor BGRA patches use the same RGB and fitted-video coordinates', () => {
  const width = 272, height = 182
  const rgba = new Uint8Array(width * height * 4), bgra = new Uint8Array(rgba.length)
  for (let y = 15; y < 167; y++) for (let x = 0; x < width; x++) {
    const color = y < 91 ? [128, 128, 128, 255] : [0, 255, 12, 255], at = (y * width + x) * 4
    rgba.set(color, at); bgra.set([color[2], color[1], color[0], color[3]], at)
  }
  const patches = sampleColorPatches(rgba, width, height)
  assert.deepEqual(patches, sampleColorPatches(bgra, width, height, true))
  assert.deepEqual(patches[0], Array.from({ length: 8 }, () => [128, 128, 128]))
  assert.deepEqual(patches[1], Array.from({ length: 8 }, () => [0, 255, 12]))
})
