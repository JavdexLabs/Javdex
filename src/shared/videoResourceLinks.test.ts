import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  inferHttpVideoResourceKind,
  maskVideoResourceLocator,
  normalizeHttpVideoResource,
  resourceSizeToBytes
} from './videoResourceLinks'

describe('videoResourceLinks', () => {
  it('normalizes HTTP identity without reordering query parameters or changing the path', () => {
    assert.deepEqual(
      normalizeHttpVideoResource('  HTTPS://Example.COM:443/Video/File.MP4?b=2&a=1#preview  '),
      {
        locator: 'https://example.com/Video/File.MP4?b=2&a=1',
        resourceKey: 'http:https://example.com/Video/File.MP4?b=2&a=1'
      }
    )
  })

  it('rejects local and executable protocols', () => {
    for (const value of [
      'file:///tmp/movie.mp4',
      'javascript:alert(1)',
      'data:video/mp4;base64,AA=='
    ]) {
      assert.throws(() => normalizeHttpVideoResource(value), /仅支持 HTTP\/HTTPS/)
    }
  })

  it('infers common video extensions as direct links and otherwise uses web links', () => {
    assert.equal(inferHttpVideoResourceKind('https://cdn.example/video.MKV?token=secret'), 'direct')
    assert.equal(inferHttpVideoResourceKind('https://example.com/watch?id=1'), 'web')
  })

  it('masks query parameters in normal display text', () => {
    assert.equal(
      maskVideoResourceLocator('https://cdn.example/media/movie.mp4?token=secret', 'direct'),
      'cdn.example / media/movie.mp4'
    )
    assert.equal(
      maskVideoResourceLocator('https://example.com/watch?id=secret', 'web'),
      'example.com / watch'
    )
  })

  it('converts optional MB, GB, and TB values to integer bytes', () => {
    assert.equal(resourceSizeToBytes('', 'MB'), null)
    assert.equal(resourceSizeToBytes('1.5', 'GB'), 1610612736)
    assert.equal(resourceSizeToBytes('2', 'TB'), 2199023255552)
    assert.throws(() => resourceSizeToBytes('-1', 'MB'), /文件大小/)
  })
})
