import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { closeDatabase, initDatabaseAtPath } from '@library/db/database'
import { createMediaLibrary, updateMediaLibraryRoot } from '@library/db/mediaLibraryRepo'
import {
  createAuthorizedMediaLibraryRootFileInspector,
  MediaLibraryRootFileMissingError
} from './mediaLibraryRootFileGuard'

function fixture(t: TestContext) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-root-file-inspector-')))
  t.after(() => {
    closeDatabase()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  initDatabaseAtPath(':memory:')
  const rootPath = path.join(directory, 'media')
  fs.mkdirSync(rootPath)
  const library = createMediaLibrary({ name: 'File inspection', roots: [{ path: rootPath }] })
  const root = library.roots[0]
  const file = path.join(rootPath, 'movie.mp4')
  fs.writeFileSync(file, 'synthetic managed movie')
  return { directory, library, root, file }
}

test('authorized inspection preserves the canonical file contract and identifies a moved file', t => {
  const f = fixture(t)
  const inspect = createAuthorizedMediaLibraryRootFileInspector()
  const checked = inspect(f.library.id, f.root.id, f.file)
  assert.equal(checked.root.id, f.root.id)
  assert.equal(checked.realPath, f.root.realPath)
  assert.equal(checked.fileRealPath, fs.realpathSync.native(f.file))
  assert.equal(checked.stat.isFile(), true)
  fs.renameSync(f.file, path.join(f.root.path, 'moved.mp4'))
  assert.throws(() => inspect(f.library.id, f.root.id, f.file), error =>
    error instanceof MediaLibraryRootFileMissingError &&
    error.message === '只能操作身份有效的启用媒体库根目录内文件')
})

for (const state of ['offline', 'changed'] as const) {
  test(`a cached plan does not confuse roots that become ${state} with missing files`, t => {
    const f = fixture(t)
    const inspect = createAuthorizedMediaLibraryRootFileInspector()
    inspect(f.library.id, f.root.id, f.file)
    fs.renameSync(f.root.path, path.join(f.directory, 'retired'))
    if (state === 'changed') fs.mkdirSync(f.root.path)
    assert.throws(() => inspect(f.library.id, f.root.id, f.file), error =>
      error instanceof Error && !(error instanceof MediaLibraryRootFileMissingError) &&
      error.message === '只能操作身份有效的启用媒体库根目录内文件')
  })
}

test('missing files may be addressed through the authorized canonical root rather than its alias', {
  skip: process.platform === 'win32'
}, t => {
  const f = fixture(t)
  const alias = path.join(f.directory, 'alias')
  fs.symlinkSync(f.root.path, alias, 'dir')
  const root = updateMediaLibraryRoot({ libraryId: f.library.id, rootId: f.root.id,
    expectedRevision: f.library.revision, patch: { path: alias } })
  const inspect = createAuthorizedMediaLibraryRootFileInspector()
  inspect(f.library.id, root.id, f.file)
  fs.renameSync(f.file, path.join(f.root.path, 'moved.mp4'))
  assert.throws(() => inspect(f.library.id, root.id, f.file), MediaLibraryRootFileMissingError)
})
