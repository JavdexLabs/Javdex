import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import { resolveMediaLibraryRootIdentity } from '@shared/mediaLibraryRootPath'
import {
  assertFileNameOnly,
  assertMediaLibraryRootFile
} from './ipcPathGuards'

function persistedRoot(rootPath: string): MediaLibraryRoot {
  const identity = resolveMediaLibraryRootIdentity(rootPath)
  return {
    id: 7,
    libraryId: 3,
    ...identity,
    position: 0,
    state: 'active',
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z'
  }
}

describe('IPC path guards', () => {
  it('rejects a rename that contains a path component', () => {
    assert.doesNotThrow(() => assertFileNameOnly('new-name.mp4'))
    assert.throws(() => assertFileNameOnly('../outside.mp4'), /不能包含目录/)
  })

  it('authorizes only files under the selected active root', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-ipc-scoped-root-'))
    const libraryRoot = path.join(tempRoot, 'library')
    const otherRoot = path.join(tempRoot, 'other')
    fs.mkdirSync(libraryRoot)
    fs.mkdirSync(otherRoot)
    const inside = path.join(libraryRoot, 'movie.mp4')
    const outside = path.join(otherRoot, 'movie.mp4')
    fs.writeFileSync(inside, '')
    fs.writeFileSync(outside, '')

    try {
      const root = persistedRoot(libraryRoot)
      assert.doesNotThrow(() => assertMediaLibraryRootFile(inside, root))
      assert.throws(() => assertMediaLibraryRootFile(outside, root), /媒体库根目录/)
      for (const state of ['disabled', 'pending_removal', 'archived'] as const) {
        assert.throws(
          () => assertMediaLibraryRootFile(inside, { ...root, state }),
          /媒体库根目录/
        )
      }
      assert.throws(
        () =>
          assertMediaLibraryRootFile(inside, {
            ...root,
            realPath: null,
            normalizedRealPath: null,
            deviceId: null,
            inode: null
          }),
        /媒体库根目录/
      )
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('rejects a path when the persisted root has been replaced', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-ipc-replaced-root-'))
    const libraryRoot = path.join(tempRoot, 'library')
    const retiredRoot = path.join(tempRoot, 'retired')
    fs.mkdirSync(libraryRoot)
    const root = persistedRoot(libraryRoot)
    fs.renameSync(libraryRoot, retiredRoot)
    fs.mkdirSync(libraryRoot)
    const replacementFile = path.join(libraryRoot, 'movie.mp4')
    fs.writeFileSync(replacementFile, '')

    try {
      assert.throws(
        () => assertMediaLibraryRootFile(replacementFile, root),
        /媒体库根目录/
      )
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('rejects a file that escapes a configured root through a symbolic link', {
    skip: process.platform === 'win32'
  }, () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-ipc-symlink-'))
    const libraryRoot = path.join(tempRoot, 'library')
    const outsideRoot = path.join(tempRoot, 'outside')
    fs.mkdirSync(libraryRoot)
    fs.mkdirSync(outsideRoot)
    const outsideFile = path.join(outsideRoot, 'movie.mp4')
    fs.writeFileSync(outsideFile, '')
    fs.symlinkSync(outsideRoot, path.join(libraryRoot, 'escape'))

    try {
      assert.throws(
        () =>
          assertMediaLibraryRootFile(
            path.join(libraryRoot, 'escape', 'movie.mp4'),
            persistedRoot(libraryRoot)
          ),
        /媒体库根目录/
      )
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
