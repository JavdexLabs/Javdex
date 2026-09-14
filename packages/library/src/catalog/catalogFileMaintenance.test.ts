import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { addMediaLibraryRoot } from '@library/db/mediaLibraryRepo'
import { insertTestVideoWithFile } from '@library/db/testVideoFixtures'
import { isStructuredError } from '@shared/protocol/errors'
import {
  filesRenameDigest,
  previewRenameCatalogFile,
  renameCatalogFile
} from './catalogFileMaintenance'

it('previews rename from the live server file without exposing host paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-rename-preview-'))
  try {
    initDatabaseAtPath(path.join(root, 'catalog.db'))
    const mount = path.join(root, 'media')
    fs.mkdirSync(mount)
    const clip = path.join(mount, 'clip.mp4')
    fs.writeFileSync(clip, 'one')
    const extra = path.join(mount, 'unknown.mp4')
    fs.writeFileSync(extra, 'loose')
    const libraryRoot = addMediaLibraryRoot({
      libraryId: 1,
      expectedRevision: 1,
      root: { path: mount }
    })
    const inserted = insertTestVideoWithFile(getDb(), {
      code: 'ABC-001',
      filePath: clip,
      rootId: libraryRoot.id
    })
    const recognized = previewRenameCatalogFile({
      libraryId: 1,
      location: { rootId: libraryRoot.id, relativePath: 'clip.mp4' },
      newFileName: 'renamed.mp4'
    })
    assert.equal(recognized.resourceId, inserted.fileId)
    assert.equal(
      recognized.planDigest,
      filesRenameDigest({
        libraryId: 1,
        resourceId: inserted.fileId,
        location: { rootId: libraryRoot.id, relativePath: 'clip.mp4' },
        newFileName: 'renamed.mp4'
      })
    )
    assert.ok(!JSON.stringify(recognized).includes(mount))

    fs.writeFileSync(clip, 'one-more')
    const afterWrite = previewRenameCatalogFile({
      libraryId: 1,
      location: { rootId: libraryRoot.id, relativePath: 'clip.mp4' },
      newFileName: 'renamed.mp4'
    })
    assert.notEqual(afterWrite.planDigest, recognized.planDigest)

    const unrecognized = previewRenameCatalogFile({
      libraryId: 1,
      location: { rootId: libraryRoot.id, relativePath: 'unknown.mp4' },
      newFileName: 'other.mp4'
    })
    assert.equal('resourceId' in unrecognized, false)
    assert.match(unrecognized.planDigest, /^[a-f0-9]{64}$/)

    try {
      previewRenameCatalogFile({
        libraryId: 1,
        location: { rootId: libraryRoot.id, relativePath: clip },
        newFileName: 'renamed.mp4'
      })
      assert.fail('expected absolute relativePath to fail')
    } catch (error) {
      assert.ok(isStructuredError(error))
      assert.equal(error.code, 'INVALID_INPUT')
    }

    await assert.rejects(
      () =>
        renameCatalogFile({
          libraryId: 1,
          resourceId: inserted.fileId,
          location: { rootId: libraryRoot.id, relativePath: 'clip.mp4' },
          newFileName: 'renamed.mp4',
          planDigest: 'a'.repeat(64)
        }),
      (error: unknown) => isStructuredError(error) && error.code === 'VERSION_CONFLICT'
    )
  } finally {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
