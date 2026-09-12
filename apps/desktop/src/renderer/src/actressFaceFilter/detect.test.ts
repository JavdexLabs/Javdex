import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isNoFaceDetectionError } from './detect'

describe('actress face detection outcome mapping', () => {
  it('maps the detector zero-face message to the no-face domain state', () => {
    assert.equal(isNoFaceDetectionError(new Error('未检测到清晰人脸，请选择更清晰的原图')), true)
    assert.equal(isNoFaceDetectionError(new Error('本地人脸检测组件初始化失败')), false)
    assert.equal(isNoFaceDetectionError('未检测到清晰人脸'), true)
  })
})
