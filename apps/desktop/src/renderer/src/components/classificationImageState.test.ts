import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classificationImageDisplayState,
  fileClassificationImageInput,
  remoteClassificationImageInput,
  videoCoverClassificationImageInput
} from './classificationImageState'

describe('classification image interaction state', () => {
  it('distinguishes formal images from dynamic fallback images', () => {
    assert.deepEqual(classificationImageDisplayState('covers/formal.jpg', 'covers/fallback.jpg'), {
      path: 'covers/formal.jpg',
      label: '正式主图'
    })
    assert.deepEqual(classificationImageDisplayState(null, 'covers/fallback.jpg'), {
      path: 'covers/fallback.jpg',
      label: '动态回退'
    })
    assert.deepEqual(classificationImageDisplayState(null, null), { path: null, label: '暂无图片' })
  })

  it('builds explicit file, URL, and video-cover commands', () => {
    assert.deepEqual(fileClassificationImageInput(' /tmp/image.jpg '), {
      source: 'file',
      sourcePath: '/tmp/image.jpg'
    })
    assert.deepEqual(remoteClassificationImageInput(' https://example.com/a.jpg '), {
      source: 'url',
      remoteUrl: 'https://example.com/a.jpg'
    })
    assert.deepEqual(videoCoverClassificationImageInput(12), {
      source: 'video-cover',
      videoId: 12
    })
    assert.equal(fileClassificationImageInput(' '), null)
    assert.equal(remoteClassificationImageInput(' '), null)
  })
})
