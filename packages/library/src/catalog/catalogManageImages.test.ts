import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isStructuredError } from '@shared/protocol/errors'
import { normalizeManageImageRelPath } from './catalogManageImages'

describe('catalog manage image paths', () => {
  it('allows catalog image prefixes and rejects traversal', () => {
    assert.equal(normalizeManageImageRelPath('covers/s11.png'), 'covers/s11.png')
    assert.equal(normalizeManageImageRelPath('/avatars/a.jpg'), 'avatars/a.jpg')
    assert.equal(normalizeManageImageRelPath('uploads/abc.webp'), 'uploads/abc.webp')
    for (const relPath of [
      '',
      '../covers/a.jpg',
      'covers/../secret',
      'covers/%2e%2e/secret',
      '/etc/passwd',
      'tmp/not-allowed.png',
      'covers/foo\0.png'
    ]) {
      try {
        normalizeManageImageRelPath(relPath)
        assert.fail(`expected reject: ${relPath}`)
      } catch (error) {
        assert.equal(isStructuredError(error) && error.code, 'INVALID_INPUT')
      }
    }
  })
})
