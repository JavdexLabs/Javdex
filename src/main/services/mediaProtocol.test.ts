import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolveMediaAssetPath, toStoredAssetPath } from './mediaProtocol'

describe('mediaProtocol', () => {
  it('resolves media URLs under the asset root', () => {
    const root = path.resolve('tmp-assets')
    const abs = resolveMediaAssetPath('media://covers/IPX-535.jpg', root)

    assert.equal(abs, path.join(root, 'covers', 'IPX-535.jpg'))
    assert.equal(toStoredAssetPath(abs!, root), 'covers/IPX-535.jpg')
  })

  it('rejects path traversal outside the asset root', () => {
    const root = path.resolve('tmp-assets')
    assert.equal(resolveMediaAssetPath('media://covers/../avatars/a.jpg', root), null)
    assert.equal(resolveMediaAssetPath('media://covers/%2E%2E/%2E%2E/secret.txt', root), null)
  })
})
