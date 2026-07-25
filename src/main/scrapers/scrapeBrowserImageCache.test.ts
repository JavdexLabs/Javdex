import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  hasImageMagicBytes,
  ImageBodyLruCache,
  isImageNetworkResource,
  networkUrlPathKey,
  normalizeNetworkUrl
} from './scrapeBrowserImageCache'

describe('normalizeNetworkUrl', () => {
  it('strips hash and lowercases host', () => {
    assert.equal(
      normalizeNetworkUrl('https://CDN.Example.com/a.jpg#x'),
      'https://cdn.example.com/a.jpg'
    )
  })

  it('returns null for invalid URLs', () => {
    assert.equal(normalizeNetworkUrl('not a url'), null)
  })
})

describe('networkUrlPathKey', () => {
  it('drops search and hash', () => {
    assert.equal(
      networkUrlPathKey('https://cdn.example.com/a.jpg?v=1#h'),
      'https://cdn.example.com/a.jpg'
    )
  })
})

describe('isImageNetworkResource', () => {
  it('accepts Image resource type', () => {
    assert.equal(isImageNetworkResource({ type: 'Image', status: 200 }), true)
  })

  it('accepts image mime types', () => {
    assert.equal(isImageNetworkResource({ mimeType: 'image/jpeg', status: 200 }), true)
  })

  it('rejects non-images and error statuses', () => {
    assert.equal(isImageNetworkResource({ type: 'Script', mimeType: 'text/javascript', status: 200 }), false)
    assert.equal(isImageNetworkResource({ type: 'Image', status: 404 }), false)
  })
})

describe('hasImageMagicBytes', () => {
  it('detects jpeg and rejects html', () => {
    assert.equal(hasImageMagicBytes(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), true)
    assert.equal(hasImageMagicBytes(Buffer.from('<html>')), false)
  })
})

describe('ImageBodyLruCache', () => {
  it('returns exact and aliased URLs', () => {
    const cache = new ImageBodyLruCache()
    const body = Buffer.from([0xff, 0xd8, 0xff, 0x01])
    cache.set(
      ['https://cdn.example.com/cover.jpg', 'http://cdn.example.com/cover.jpg'],
      body
    )
    assert.equal(cache.get('https://cdn.example.com/cover.jpg'), body)
    assert.equal(cache.get('http://cdn.example.com/cover.jpg'), body)
  })

  it('matches unique path when query differs', () => {
    const cache = new ImageBodyLruCache()
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    cache.set(['https://cdn.example.com/a.png?token=1'], body)
    assert.equal(cache.get('https://cdn.example.com/a.png?token=2'), body)
  })

  it('does not path-match when multiple distinct bodies share a path', () => {
    const cache = new ImageBodyLruCache()
    const a = Buffer.from([1, 2, 3])
    const b = Buffer.from([4, 5, 6])
    cache.set(['https://cdn.example.com/a.jpg?v=1'], a)
    cache.set(['https://cdn.example.com/a.jpg?v=2'], b)
    assert.equal(cache.get('https://cdn.example.com/a.jpg?v=3'), null)
  })

  it('evicts oldest entries by count', () => {
    const cache = new ImageBodyLruCache(2, 1024 * 1024)
    const a = Buffer.from([1])
    const b = Buffer.from([2])
    const c = Buffer.from([3])
    cache.set(['https://cdn.example.com/1.jpg'], a)
    cache.set(['https://cdn.example.com/2.jpg'], b)
    cache.set(['https://cdn.example.com/3.jpg'], c)
    assert.equal(cache.get('https://cdn.example.com/1.jpg'), null)
    assert.equal(cache.get('https://cdn.example.com/2.jpg'), b)
    assert.equal(cache.get('https://cdn.example.com/3.jpg'), c)
  })

  it('clears all state', () => {
    const cache = new ImageBodyLruCache()
    cache.set(['https://cdn.example.com/a.jpg'], Buffer.from([1]))
    cache.clear()
    assert.equal(cache.size, 0)
    assert.equal(cache.get('https://cdn.example.com/a.jpg'), null)
  })
})
