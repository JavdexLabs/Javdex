import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  openRemoteImageDiskCache,
  remoteImageCacheCatalogDir
} from './remoteImageDiskCache'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('remoteImageDiskCache', () => {
  it('hits after a write, isolates catalogs, and evicts the least recently used entry', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s11-imgcache-'))
    roots.push(root)
    const first = openRemoteImageDiskCache({
      userDataPath: root,
      catalogId: 'catalog-a',
      maxEntries: 2,
      maxBytes: 1024
    })
    first.set('covers/a.jpg', 'image/jpeg', Buffer.from('aaa'))
    first.set('covers/b.jpg', 'image/jpeg', Buffer.from('bbb'))
    assert.equal(first.get('covers/a.jpg')?.body.toString(), 'aaa')
    first.set('covers/c.jpg', 'image/jpeg', Buffer.from('ccc'))
    assert.equal(first.get('covers/a.jpg')?.body.toString(), 'aaa')
    assert.equal(first.get('covers/b.jpg'), null)
    assert.equal(first.get('covers/c.jpg')?.body.toString(), 'ccc')

    const other = openRemoteImageDiskCache({
      userDataPath: root,
      catalogId: 'catalog-b',
      maxEntries: 2,
      maxBytes: 1024
    })
    assert.equal(other.get('covers/a.jpg'), null)
    other.set('covers/a.jpg', 'image/png', Buffer.from('other'))
    assert.equal(other.get('covers/a.jpg')?.mime, 'image/png')
    assert.equal(first.get('covers/a.jpg')?.body.toString(), 'aaa')
    assert.notEqual(
      remoteImageCacheCatalogDir(root, 'catalog-a'),
      remoteImageCacheCatalogDir(root, 'catalog-b')
    )
  })

  it('reopens from disk, skips oversized bodies, and drops truncated files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s11-imgcache-reopen-'))
    roots.push(root)
    const cache = openRemoteImageDiskCache({
      userDataPath: root,
      catalogId: 'catalog-a',
      maxEntries: 4,
      maxBytes: 8
    })
    cache.set('covers/keep.jpg', 'image/jpeg', Buffer.from('keep'))
    cache.set('covers/huge.jpg', 'image/jpeg', Buffer.from('0123456789'))
    assert.equal(cache.get('covers/huge.jpg'), null)
    const reopened = openRemoteImageDiskCache({
      userDataPath: root,
      catalogId: 'catalog-a',
      maxEntries: 4,
      maxBytes: 8
    })
    assert.equal(reopened.get('covers/keep.jpg')?.body.toString(), 'keep')
    const stored = fs.readdirSync(remoteImageCacheCatalogDir(root, 'catalog-a')).find((name) => name.endsWith('.bin'))
    assert.ok(stored)
    fs.writeFileSync(path.join(remoteImageCacheCatalogDir(root, 'catalog-a'), stored!), Buffer.from('x'))
    assert.equal(reopened.get('covers/keep.jpg'), null)
  })
})
