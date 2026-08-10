import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  inferHttpVideoResourceKind,
  inferVideoResourceKind,
  maskVideoResourceLocator,
  normalizeExternalVideoResource,
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

  it('uses the Magnet xt identity while preserving the original link and deriving a name', () => {
    const first = normalizeExternalVideoResource(
      'magnet:?xt=urn:btih:ABCDEF1234567890&dn=Example%20Movie&tr=udp%3A%2F%2Ftracker.one'
    )
    const second = normalizeExternalVideoResource(
      'magnet:?tr=udp%3A%2F%2Ftracker.two&xt=urn:btih:abcdef1234567890&dn=Renamed'
    )
    assert.equal(first.kind, 'magnet')
    assert.equal(first.resourceKey, second.resourceKey)
    assert.equal(first.suggestedDisplayName, 'Example Movie')
    assert.match(first.locator, /tracker\.one/)
  })

  it('uses the ED2K file hash identity while deriving its file name', () => {
    const first = normalizeExternalVideoResource(
      'ed2k://|file|Example%20Movie.mp4|123456|ABCDEF0123456789ABCDEF0123456789|/'
    )
    const renamed = normalizeExternalVideoResource(
      'ed2k://|file|Renamed.mkv|999999|abcdef0123456789abcdef0123456789|/'
    )
    assert.equal(first.kind, 'ed2k')
    assert.equal(first.resourceKey, renamed.resourceKey)
    assert.equal(first.suggestedDisplayName, 'Example Movie.mp4')
    assert.equal(
      inferVideoResourceKind('ed2k://|file|Example.mp4|1|abcdef0123456789abcdef0123456789|/'),
      'ed2k'
    )
  })
})
