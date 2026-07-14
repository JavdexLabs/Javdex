import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AVATAR_VIEW_SIZE,
  getCropImageLayout,
  getDefaultCropTransform,
  getSavedAvatarCropTransform,
  getSmartAvatarCropTransform,
  isDefaultCropTransform
} from './avatarCrop'
import type { AvatarFaceCandidate, NormalizedPoint } from '../avatarAutoCrop/types'
import {
  DEFAULT_AVATAR_FACE_RATIO,
  DEFAULT_AVATAR_FACE_SCALE_PRESET,
  normalizeAvatarFaceRatio,
  normalizeAvatarFaceScalePreset
} from '@shared/avatarFaceScale'
import {
  DEFAULT_AVATAR_CENTERING_MODE,
  normalizeAvatarCenteringMode
} from '@shared/avatarCentering'

function point(x: number, y: number, iw: number, ih: number): NormalizedPoint {
  return { x: x / iw, y: y / ih }
}

function meshCandidate(iw: number, ih: number, scale = 1): AvatarFaceCandidate {
  const centerX = iw / 2
  const eyeY = ih * 0.3
  return {
    id: 'face-1',
    confidence: 0.98,
    prominence: 1,
    box: { x: 0.4, y: 0.18, width: 0.2, height: 0.3 },
    leftEye: point(centerX - 62.5 * scale, eyeY, iw, ih),
    rightEye: point(centerX + 62.5 * scale, eyeY, iw, ih),
    ovalTop: point(centerX, eyeY - 115 * scale, iw, ih),
    chin: point(centerX, eyeY + 235 * scale, iw, ih),
    leftCheek: point(centerX - 130 * scale, eyeY + 65 * scale, iw, ih),
    rightCheek: point(centerX + 130 * scale, eyeY + 65 * scale, iw, ih),
    headBounds: null,
    geometrySource: 'mesh'
  }
}

describe('renderer avatarCrop', () => {
  it('falls back to the standard preset for invalid stored values', () => {
    assert.equal(normalizeAvatarFaceScalePreset('close'), 'close')
    assert.equal(normalizeAvatarFaceScalePreset('custom'), DEFAULT_AVATAR_FACE_SCALE_PRESET)
    assert.equal(normalizeAvatarFaceRatio('invalid'), DEFAULT_AVATAR_FACE_RATIO)
    assert.equal(normalizeAvatarFaceRatio(0.42), 0.5)
    assert.equal(normalizeAvatarFaceRatio(0.81), 0.75)
  })

  it('falls back to face centering for invalid stored values', () => {
    assert.equal(normalizeAvatarCenteringMode('head'), 'head')
    assert.equal(normalizeAvatarCenteringMode('body'), DEFAULT_AVATAR_CENTERING_MODE)
  })

  it('keeps landmark-based faces at the same visual size across source images', () => {
    for (const [iw, ih, scale] of [[1200, 1800, 1], [2400, 1600, 2]] as const) {
      const candidate = meshCandidate(iw, ih, scale)
      const transform = getSmartAvatarCropTransform(iw, ih, candidate)
      const layout = getCropImageLayout(
        iw,
        ih,
        transform.baseScale,
        transform.zoom,
        transform.offsetX,
        transform.offsetY,
        AVATAR_VIEW_SIZE
      )
      const renderedOvalHeight = (candidate.chin!.y - candidate.ovalTop!.y) * layout.height
      const renderedEyeDistance =
        (candidate.rightEye!.x - candidate.leftEye!.x) * layout.width
      assert.ok(
        Math.abs(renderedOvalHeight / AVATAR_VIEW_SIZE - DEFAULT_AVATAR_FACE_RATIO) < 0.01
      )
      const expectedEyeDistanceRatio = 0.25 * (DEFAULT_AVATAR_FACE_RATIO / 0.7)
      assert.ok(
        Math.abs(renderedEyeDistance / AVATAR_VIEW_SIZE - expectedEyeDistanceRatio) < 0.01
      )
    }
  })

  it('reports when a tight source cannot reach the requested face size', () => {
    const candidate = meshCandidate(500, 500, 1.2)
    const transform = getSmartAvatarCropTransform(500, 500, candidate)
    assert.equal(transform.zoom, 1)
    assert.equal(transform.constrained, true)
    assert.equal(transform.constraint, 'source-too-tight')
  })

  it('applies the continuous face ratio consistently', () => {
    const candidate = meshCandidate(1200, 1800)
    for (const expectedRatio of [0.5, 0.63, 0.75]) {
      const transform = getSmartAvatarCropTransform(
        1200,
        1800,
        candidate,
        AVATAR_VIEW_SIZE,
        expectedRatio
      )
      const layout = getCropImageLayout(
        1200,
        1800,
        transform.baseScale,
        transform.zoom,
        transform.offsetX,
        transform.offsetY,
        AVATAR_VIEW_SIZE
      )
      const renderedOvalHeight = (candidate.chin!.y - candidate.ovalTop!.y) * layout.height
      assert.ok(Math.abs(renderedOvalHeight / AVATAR_VIEW_SIZE - expectedRatio) < 0.01)
    }
  })

  it('centers the estimated crown-to-chin region in head mode', () => {
    const iw = 1200
    const ih = 1800
    const candidate = meshCandidate(iw, ih)
    const transform = getSmartAvatarCropTransform(
      iw,
      ih,
      candidate,
      AVATAR_VIEW_SIZE,
      0.7,
      'head',
      true
    )
    const layout = getCropImageLayout(
      iw,
      ih,
      transform.baseScale,
      transform.zoom,
      transform.offsetX,
      transform.offsetY,
      AVATAR_VIEW_SIZE
    )
    const ovalTopY = layout.top + candidate.ovalTop!.y * layout.height
    const chinY = layout.top + candidate.chin!.y * layout.height
    const crownY = ovalTopY - (chinY - ovalTopY) * 0.35
    assert.ok(Math.abs((crownY + chinY) / 2 / AVATAR_VIEW_SIZE - 0.5) < 0.01)
  })

  it('centers segmented visible head bounds instead of the facial axis', () => {
    const iw = 1200
    const ih = 1800
    const candidate = {
      ...meshCandidate(iw, ih),
      headBounds: { x: 0.22, y: 0.08, width: 0.42, height: 0.44 }
    }
    const transform = getSmartAvatarCropTransform(
      iw,
      ih,
      candidate,
      AVATAR_VIEW_SIZE,
      0.7,
      'head',
      true
    )
    const layout = getCropImageLayout(
      iw,
      ih,
      transform.baseScale,
      transform.zoom,
      transform.offsetX,
      transform.offsetY,
      AVATAR_VIEW_SIZE
    )
    const headCenterX =
      layout.left + (candidate.headBounds.x + candidate.headBounds.width / 2) * layout.width
    const headCenterY =
      layout.top + (candidate.headBounds.y + candidate.headBounds.height / 2) * layout.height
    const renderedHeadRatio = Math.max(
      (candidate.headBounds.width * layout.width) / AVATAR_VIEW_SIZE,
      (candidate.headBounds.height * layout.height) / AVATAR_VIEW_SIZE
    )
    assert.ok(Math.abs(headCenterX / AVATAR_VIEW_SIZE - 0.5) < 0.01)
    assert.ok(Math.abs(headCenterY / AVATAR_VIEW_SIZE - 0.5) < 0.01)
    assert.ok(renderedHeadRatio <= 0.94 + 0.01)
  })

  it('keeps zoom identical across centering modes', () => {
    const iw = 1200
    const ih = 1800
    const candidate = {
      ...meshCandidate(iw, ih),
      headBounds: { x: 0.29, y: 0.12, width: 0.42, height: 0.35 }
    }
    for (const preserveFullHead of [false, true]) {
      const face = getSmartAvatarCropTransform(
        iw,
        ih,
        candidate,
        AVATAR_VIEW_SIZE,
        0.67,
        'face',
        preserveFullHead
      )
      const head = getSmartAvatarCropTransform(
        iw,
        ih,
        candidate,
        AVATAR_VIEW_SIZE,
        0.67,
        'head',
        preserveFullHead
      )
      assert.equal(head.zoom, face.zoom)
      assert.equal(head.baseScale, face.baseScale)
    }
  })

  it('keeps face-ratio changes effective when full-head protection is disabled', () => {
    const iw = 1200
    const ih = 1800
    const candidate = {
      ...meshCandidate(iw, ih),
      headBounds: { x: 0.29, y: 0.12, width: 0.42, height: 0.35 }
    }
    const renderedRatios = [0.5, 0.62, 0.75].map((faceRatio) => {
      const transform = getSmartAvatarCropTransform(
        iw,
        ih,
        candidate,
        AVATAR_VIEW_SIZE,
        faceRatio,
        'head',
        false
      )
      const layout = getCropImageLayout(
        iw,
        ih,
        transform.baseScale,
        transform.zoom,
        transform.offsetX,
        transform.offsetY,
        AVATAR_VIEW_SIZE
      )
      return ((candidate.chin!.y - candidate.ovalTop!.y) * layout.height) / AVATAR_VIEW_SIZE
    })
    assert.ok(renderedRatios[0] < renderedRatios[1])
    assert.ok(renderedRatios[1] < renderedRatios[2])
    assert.ok(renderedRatios[2] - renderedRatios[0] > 0.12)
  })
  it('keeps legacy near-square avatars aligned with cover preview layout', () => {
    const saved = getSavedAvatarCropTransform(512, 511, AVATAR_VIEW_SIZE)
    const preview = getDefaultCropTransform(512, 511, AVATAR_VIEW_SIZE)
    assert.deepEqual(saved, preview)

    const layout = getCropImageLayout(
      512,
      511,
      saved.baseScale,
      saved.zoom,
      saved.offsetX,
      saved.offsetY,
      AVATAR_VIEW_SIZE
    )
    assert.equal(layout.top, 0)
  })

  it('detects the native cover-compatible default transform', () => {
    assert.equal(isDefaultCropTransform(1, 0, 0), true)
    assert.equal(isDefaultCropTransform(1 + 1e-8, -1e-8, 1e-8), true)
    assert.equal(isDefaultCropTransform(1.01, 0, 0), false)
    assert.equal(isDefaultCropTransform(1, 0.5, 0), false)
  })
})
