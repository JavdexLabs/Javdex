import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertConfiguredLibraryFile, assertFileNameOnly } from './ipcPathGuards'

describe('IPC path guards', () => {
  it('accepts files below configured roots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-ipc-path-'))
    const file = path.join(root, 'movie.mp4')
    fs.writeFileSync(file, '')
    try {
      assert.doesNotThrow(() => assertConfiguredLibraryFile(file, [root]))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects relative paths and sibling-prefix escapes', () => {
    const root = path.join(path.sep, 'media', 'library')
    assert.throws(() => assertConfiguredLibraryFile('movie.mp4', [root]), /媒体库目录内/)
    assert.throws(
      () => assertConfiguredLibraryFile(path.join(path.sep, 'media', 'library-copy', 'movie.mp4'), [root]),
      /媒体库目录内/
    )
  })

  it('rejects a rename that contains a path component', () => {
    assert.doesNotThrow(() => assertFileNameOnly('new-name.mp4'))
    assert.throws(() => assertFileNameOnly('../outside.mp4'), /不能包含目录/)
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
        () => assertConfiguredLibraryFile(path.join(libraryRoot, 'escape', 'movie.mp4'), [libraryRoot]),
        /媒体库目录内/
      )
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
