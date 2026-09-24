import { afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { addMediaLibraryRoot } from '@library/db/mediaLibraryRepo'
import { insertTestVideoWithFile } from '@library/db/testVideoFixtures'
import { isStructuredError } from '@shared/protocol/errors'
import { ensureCatalogIdentity } from './catalogIdentity'
import { readCatalogMutationIntent, readOperationReceipt } from './catalogOperations'
import { readVideoAggregateVersion } from './catalogVideoVersion'
import {
  executeCatalogFileMaintenance,
  hasFileMaintenanceJournal,
  previewRenameCatalogFile,
  readFileMaintenanceVersions
} from './catalogFileMaintenance'

let directory: string
afterEach(() => {
  closeDatabase()
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-file-execute-')))
  initDatabaseAtPath(path.join(directory, 'catalog.db'))
  ensureCatalogIdentity()
  const mount = path.join(directory, 'media')
  fs.mkdirSync(mount)
  const root = addMediaLibraryRoot({ libraryId: 1, expectedRevision: 1, root: { path: mount } })
  return { mount, location: { rootId: root.id, relativePath: 'clip.mp4' }, libraryId: 1 }
}

for (const remoteSafe of [false, true]) {
  it(`executes rename and replays its receipt with remoteSafe=${remoteSafe}`, async () => {
    const { mount, ...location } = fixture()
    const oldPath = path.join(mount, 'clip.mp4')
    fs.writeFileSync(oldPath, 'video')
    insertTestVideoWithFile(getDb(), { code: 'ABC-001', filePath: oldPath, rootId: location.location.rootId })
    const input = { ...location, newFileName: 'renamed.mp4' }
    const preview = previewRenameCatalogFile(input)
    const request = {
      operation: 'files.rename' as const,
      operationId: randomUUID(), writerEpoch: 0,
      input: { ...input, resourceId: preview.resourceId,
        ...(remoteSafe ? { planDigest: preview.planDigest } : {}) },
      expectedVersions: preview.expectedVersions
    }
    const first = await executeCatalogFileMaintenance(request, { remoteSafe })
    assert.equal(first.outcome, 'applied')
    assert.equal(first.data.newPath, remoteSafe ? 'renamed.mp4' : path.join(mount, 'renamed.mp4'))
    assert.equal(fs.existsSync(oldPath), false)
    assert.equal(fs.readFileSync(path.join(mount, 'renamed.mp4'), 'utf8'), 'video')
    assert.equal(hasFileMaintenanceJournal(request.operationId), false)
    assert.equal(readCatalogMutationIntent(request.operationId), null)
    assert.equal(readOperationReceipt(request.operationId)?.status, 'applied')
    const retry = await executeCatalogFileMaintenance(request, { remoteSafe })
    assert.equal(retry.outcome, 'duplicate')
    assert.deepEqual(retry.data, first.data)
    await assert.rejects(executeCatalogFileMaintenance({
      ...request, input: { ...request.input, newFileName: 'different.mp4' }
    }), (error: unknown) => isStructuredError(error) && error.code === 'OPERATION_KEY_REUSED')
  })
}

it('rejects stale rename versions and clears the unused intent', async () => {
  const { mount, ...location } = fixture()
  const filePath = path.join(mount, 'clip.mp4')
  fs.writeFileSync(filePath, 'video')
  insertTestVideoWithFile(getDb(), { code: 'ABC-001', filePath, rootId: location.location.rootId })
  const input = { ...location, newFileName: 'renamed.mp4' }
  const preview = previewRenameCatalogFile(input)
  const operationId = randomUUID()
  await assert.rejects(executeCatalogFileMaintenance({
    operation: 'files.rename', operationId, writerEpoch: 0,
    input: { ...input, resourceId: preview.resourceId, planDigest: preview.planDigest },
    expectedVersions: { ...preview.expectedVersions, R: { generation: 1, revision: 0 } }
  }), (error: unknown) => isStructuredError(error) && error.code === 'VERSION_CONFLICT')
  assert.equal(fs.existsSync(filePath), true)
  assert.equal(readCatalogMutationIntent(operationId), null)
  assert.equal(hasFileMaintenanceJournal(operationId), false)
  assert.equal(readOperationReceipt(operationId), null)
})

for (const existing of [false, true]) {
  it(`imports a manual STRM target (${existing ? 'existing' : 'new'}) and replays after source removal`, async () => {
    const { mount, ...location } = fixture()
    location.location.relativePath = 'manual.strm'
    fs.writeFileSync(path.join(mount, 'manual.strm'), 'https://example.test/video.mp4')
    const videoId = existing
      ? Number(getDb().prepare("INSERT INTO videos(code) VALUES ('ABC-001')").run().lastInsertRowid)
      : undefined
    const request = {
      operation: 'files.importManual' as const, operationId: randomUUID(), writerEpoch: 0,
      input: { ...location, code: 'ABC-001', target: videoId
        ? { kind: 'existing' as const, videoId } : { kind: 'new' as const } },
      expectedVersions: { ...readFileMaintenanceVersions(location),
        ...(videoId ? { V: readVideoAggregateVersion(videoId)! } : {}) }
    }
    if (videoId) {
      await assert.rejects(executeCatalogFileMaintenance({
        ...request, expectedVersions: { ...request.expectedVersions, V: undefined }
      }), (error: unknown) => isStructuredError(error) && error.code === 'INVALID_INPUT')
      await assert.rejects(executeCatalogFileMaintenance({
        ...request, expectedVersions: { ...request.expectedVersions, V: { generation: 1, revision: 0 } }
      }), (error: unknown) => isStructuredError(error) && error.code === 'VERSION_CONFLICT')
      assert.equal(readOperationReceipt(request.operationId), null)
    }
    const first = await executeCatalogFileMaintenance(request)
    assert.equal(first.outcome, 'applied')
    assert.equal(first.data.imported, true)
    fs.unlinkSync(path.join(mount, 'manual.strm'))
    const retry = await executeCatalogFileMaintenance(request)
    assert.equal(retry.outcome, 'duplicate')
    assert.deepEqual(retry.data, first.data)
    assert.equal(retry.receipt.digest, first.receipt.digest)
    await assert.rejects(executeCatalogFileMaintenance({
      ...request, input: { ...request.input, code: 'OTHER-001' }
    }), (error: unknown) => isStructuredError(error) && error.code === 'OPERATION_KEY_REUSED')
    assert.equal((getDb().prepare('SELECT COUNT(*) AS count FROM video_resources').get() as { count: number }).count, 1)
    assert.equal(readCatalogMutationIntent(request.operationId), null)
    assert.equal(hasFileMaintenanceJournal(request.operationId), false)
  })
}
