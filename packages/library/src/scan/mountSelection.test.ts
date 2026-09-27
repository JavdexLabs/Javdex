import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { configureLibraryHost, resetLibraryHostForTests } from '../runtime/host'
import { browseMediaMount, resolveMountSelectionPath } from './mountSelection'

test('browse and select only configured media mount directories', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mount-selection-'))
  const mounted = path.join(temporary, 'mounted')
  const outside = path.join(temporary, 'outside')
  fs.mkdirSync(path.join(mounted, 'Films', 'Sub'), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(mounted, 'video.mp4'), '')
  configureLibraryHost({ userDataPath: () => temporary, mediaMounts: () => ({ library: mounted }) })
  try {
    const mounts = browseMediaMount({})
    assert.deepEqual(mounts.mounts, [{ id: 'library', path: mounted }])
    assert.equal(mounts.current, null)
    assert.deepEqual(browseMediaMount({ mountSelectionId: 'library' }).directories,
      [{ name: 'Films', relativePath: 'Films' }])
    assert.deepEqual(browseMediaMount({ mountSelectionId: 'library', search: 'film' }).directories,
      [{ name: 'Films', relativePath: 'Films' }])
    assert.deepEqual(browseMediaMount({ mountSelectionId: 'library', search: 'other' }).directories, [])
    assert.deepEqual(browseMediaMount({ mountSelectionId: 'library', relativePath: 'Films' }).directories,
      [{ name: 'Sub', relativePath: 'Films/Sub' }])
    assert.equal(resolveMountSelectionPath('library', 'Films/Sub'), fs.realpathSync.native(path.join(mounted, 'Films', 'Sub')))
    for (const relativePath of ['../outside', '/outside', 'Films/../../outside', 'Films\\Sub', 'Films//Sub']) {
      assert.throws(() => resolveMountSelectionPath('library', relativePath), { code: 'INVALID_INPUT' })
    }
    assert.throws(() => browseMediaMount({ mountSelectionId: 'missing' }), { code: 'INVALID_INPUT' })
    assert.throws(() => browseMediaMount({ mountSelectionId: 'constructor' }), { code: 'INVALID_INPUT' })
    assert.throws(() => browseMediaMount({ relativePath: 'Films' }), { code: 'INVALID_INPUT' })

    const link = path.join(mounted, 'linked')
    try {
      fs.symlinkSync(outside, link, 'dir')
      assert.equal(browseMediaMount({ mountSelectionId: 'library' }).directories.some((item) => item.name === 'linked'), false)
      assert.throws(() => resolveMountSelectionPath('library', 'linked'), { code: 'INVALID_INPUT' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    }
  } finally {
    resetLibraryHostForTests()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})
