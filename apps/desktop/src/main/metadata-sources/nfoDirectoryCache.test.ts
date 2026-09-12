import assert from 'node:assert/strict'
import { it } from 'node:test'
import { NfoDirectoryCache, NFO_DIRECTORY_CACHE_MAX_BYTES, NFO_DIRECTORY_CACHE_MAX_SCOPES } from './nfoDirectoryCache'

it('caps scopes without eviction or replacement and starts fresh per instance', () => {
  const cache = new NfoDirectoryCache<number>()
  for (let index = 0; index < NFO_DIRECTORY_CACHE_MAX_SCOPES; index++) {
    assert.equal(cache.admit(String(index), index, new Map()), true)
  }
  assert.equal(cache.admit('overflow', 100, new Map()), false)
  assert.equal(cache.admit('0', 999, new Map()), false)
  assert.equal(cache.get('0'), 0)
  assert.equal(cache.get('overflow'), undefined)
  const fresh = new NfoDirectoryCache<number>()
  assert.equal(fresh.get('0'), undefined)
  assert.equal(fresh.admit('overflow', 100, new Map()), true)
})

it('accounts exact encoded UTF8 keys, map keys and values, and summary code at the byte boundary', () => {
  const cache = new NfoDirectoryCache<number>()
  const key = '库"', code = '号\\', name = '名\n'
  const encoded = (value: string) => Buffer.byteLength(JSON.stringify(value), 'utf8')
  const fixed = encoded(key) + encoded(code) + encoded(name)
  const value = 'a'.repeat(NFO_DIRECTORY_CACHE_MAX_BYTES - fixed - 2)
  assert.equal(cache.admit(key, 1, new Map([[name, value + 'a']]), code), false)
  assert.equal(cache.get(key), undefined)
  assert.equal(cache.admit(key, 2, new Map([[name, value]]), code), true)
  assert.equal(cache.get(key), 2)
  assert.equal(cache.admit('x', 3, new Map()), false)
})

it('rejection consumes neither scope slots nor bytes, including a huge key or code with no names', () => {
  const cache = new NfoDirectoryCache<number>()
  const oversized = 'x'.repeat(NFO_DIRECTORY_CACHE_MAX_BYTES)
  assert.equal(cache.admit(oversized, 1, new Map()), false)
  assert.equal(cache.admit('code', 1, new Map(), oversized), false)
  for (let index = 0; index < NFO_DIRECTORY_CACHE_MAX_SCOPES; index++) {
    assert.equal(cache.admit(String(index), index, new Map()), true)
  }
})
