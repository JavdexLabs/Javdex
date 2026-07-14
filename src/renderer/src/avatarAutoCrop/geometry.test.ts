import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  headBoundsFromHairMask,
  isAmbiguousFaceSelection,
  mapRoiPointToImage,
  mergeDuplicateCandidates,
  normalizeDetectionBox,
  rankFaceCandidates,
  type RawFaceCandidate
} from './geometry'

function raw(
  x: number,
  y: number,
  width: number,
  height: number,
  confidence = 0.9
): RawFaceCandidate {
  return {
    confidence,
    box: { x, y, width, height },
    keypoints: [{ x: x + width * 0.35, y: y + height * 0.4 }, { x: x + width * 0.65, y: y + height * 0.4 }]
  }
}

describe('avatar auto-crop geometry', () => {
  it('rejects invalid boxes and clamps valid detector bounds', () => {
    assert.equal(normalizeDetectionBox(0, 0, 0, 20, 100, 100), null)
    assert.deepEqual(normalizeDetectionBox(-10, 10, 50, 100, 100, 100), {
      x: 0,
      y: 0.1,
      width: 0.4,
      height: 0.9
    })
  })

  it('merges overlapping tiled detections and preserves the strongest result', () => {
    const merged = mergeDuplicateCandidates([
      raw(0.3, 0.2, 0.25, 0.3, 0.82),
      raw(0.31, 0.21, 0.25, 0.3, 0.96),
      raw(0.7, 0.2, 0.15, 0.2, 0.88)
    ])
    assert.equal(merged.length, 2)
    assert.equal(merged[0].confidence, 0.96)
  })

  it('requires an explicit choice when two faces have similar prominence', () => {
    const ranked = rankFaceCandidates([
      raw(0.2, 0.2, 0.25, 0.3, 0.94),
      raw(0.55, 0.2, 0.24, 0.29, 0.92)
    ])
    assert.equal(ranked.length, 2)
    assert.equal(isAmbiguousFaceSelection(ranked), true)
  })

  it('maps ROI landmarks back to full-image normalized coordinates', () => {
    const mapped = mapRoiPointToImage(
      { x: 0.25, y: 0.75 },
      { x: 0.2, y: 0.1, width: 0.4, height: 0.6 }
    )
    assert.ok(Math.abs(mapped.x - 0.3) < 1e-12)
    assert.ok(Math.abs(mapped.y - 0.55) < 1e-12)
  })

  it('uses the hair component attached to the face for visible head bounds', () => {
    const candidate = rankFaceCandidates([raw(0.42, 0.32, 0.16, 0.2, 0.95)])[0]
    const maskWidth = 100
    const maskHeight = 100
    const mask = new Uint8Array(maskWidth * maskHeight)
    for (let y = 15; y <= 42; y += 1) {
      for (let x = 15; x <= 59; x += 1) mask[y * maskWidth + x] = 1
    }
    // Unrelated segmentation noise must not pull the selected head to the right.
    for (let y = 15; y <= 20; y += 1) {
      for (let x = 76; x <= 82; x += 1) mask[y * maskWidth + x] = 1
    }
    const bounds = headBoundsFromHairMask({
      mask,
      maskWidth,
      maskHeight,
      hairCategory: 1,
      roi: { x: 0.2, y: 0.1, width: 0.6, height: 0.6 },
      candidate
    })
    assert.ok(bounds)
    assert.ok(bounds.x < candidate.box.x)
    assert.ok(bounds.y < candidate.box.y)
    assert.ok(bounds.x + bounds.width / 2 < candidate.box.x + candidate.box.width / 2)
    assert.ok(bounds.y + bounds.height >= candidate.box.y + candidate.box.height)
  })
})
