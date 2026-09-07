import assert from 'node:assert/strict'
import { it } from 'node:test'
import { loadAvatarAnalysisImage } from './image'

it('requests CORS before loading a media avatar so its bitmap can cross the Worker boundary', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Image')
  let requestMode: string | undefined
  class ImageStub {
    crossOrigin?: string
    naturalWidth = 256
    naturalHeight = 256
    onload?: () => void
    set src(url: string) {
      assert.equal(url, 'media://avatars/example.jpg')
      requestMode = this.crossOrigin
      this.onload?.()
    }
  }
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: ImageStub })
  try {
    const image = await loadAvatarAnalysisImage('media://avatars/example.jpg')
    assert.equal(requestMode, 'anonymous')
    assert.equal(image.naturalWidth, 256)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'Image', previous)
    else Reflect.deleteProperty(globalThis, 'Image')
  }
})
