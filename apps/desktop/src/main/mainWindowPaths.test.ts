import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import path from 'node:path'
import { resolveMainWindowAssetPaths } from './mainWindowPaths'

describe('main window asset paths', () => {
  it('resolves preload and renderer from the app root when appMain is emitted as a chunk', () => {
    const appRoot = path.join(path.sep, 'Applications', 'Javdex.app', 'Contents', 'Resources', 'app.asar')
    const emittedChunkDir = path.join(appRoot, 'out', 'main', 'chunks')

    const paths = resolveMainWindowAssetPaths(appRoot)

    assert.equal(paths.preload, path.join(appRoot, 'out', 'preload', 'index.js'))
    assert.equal(paths.renderer, path.join(appRoot, 'out', 'renderer', 'index.html'))
    assert.notEqual(path.dirname(paths.preload), path.join(emittedChunkDir, '..', 'preload'))
  })
})
