import { it } from 'node:test'
import assert from 'node:assert/strict'
import { imageThumbnailUrl, parseImageThumbnailSize } from './imageVariants'

it('only accepts finite thumbnail variants and preserves preview URL components', () => {
  assert.equal(parseImageThumbnailSize(null), undefined)
  for (const size of [320, 640, 1280]) assert.equal(parseImageThumbnailSize(String(size)), size)
  for (const value of ['', '0', '0320', '999999', '640.0', 'NaN']) assert.throws(() => parseImageThumbnailSize(value))
  assert.equal(imageThumbnailUrl('/api/videos/1/images/cover?v=2#preview', 640), '/api/videos/1/images/cover?v=2&size=640#preview')
  assert.equal(imageThumbnailUrl('media://covers/a%20b.jpg', 320), 'media://covers/a%20b.jpg?size=320')
  for (const src of ['https://example.test/image.jpg?v=2', '//example.test/image.jpg', 'data:image/png;base64,AAAA', 'blob:http://localhost/abc']) {
    assert.equal(imageThumbnailUrl(src, 320), src)
  }
})
