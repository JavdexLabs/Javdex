import { afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { getActressAvatarRecord, upsertActressFromScrape } from '@library/db/actressRepo'
import { mediaAssetStore } from '@library/mediaAssetStore'
import { isStructuredError } from '@shared/protocol/errors'
import { ensureCatalogIdentity } from './catalogIdentity'
import { editCatalogActress } from './catalogActressEdit'
import { readActressAggregateVersion } from './catalogAggregateVersion'
import { readOperationReceipt } from './catalogOperations'
import { completeCatalogUploadFromBuffer, createCatalogUpload, readCatalogUpload } from './catalogUploads'

let directory: string | undefined
afterEach(() => {
  closeDatabase()
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
  directory = undefined
  delete process.env.JAVDEX_TEST_USER_DATA
})

function fixture() {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-actress-edit-'))
  process.env.JAVDEX_TEST_USER_DATA = directory
  initDatabaseAtPath(path.join(directory, 'library.db'))
  const identity = ensureCatalogIdentity()
  const actressId = upsertActressFromScrape('Original', null)
  return { actressId, identity, context: {
    operationId: randomUUID(), writerEpoch: 0,
    expectedVersions: { A: readActressAggregateVersion(actressId)! }
  } }
}

async function image(red = 30) {
  return sharp({ create: { width: 16, height: 16, channels: 3, background: { r: red, g: 40, b: 50 } } })
    .png().toBuffer()
}

it('commits one profile revision, replays its receipt, and rejects stale or reused operations', () => {
  const { actressId, context } = fixture()
  const input = { actressId, fields: { main_name: 'Updated', aliases: ['Alias'] } }
  const result = editCatalogActress(input, context)
  assert.equal(result.data.versions.A.revision, context.expectedVersions.A.revision + 1)
  assert.deepEqual(editCatalogActress(input, context).data, result.data)
  assert.equal(editCatalogActress(input, context).outcome, 'duplicate')
  assert.deepEqual(readActressAggregateVersion(actressId), result.data.versions.A)
  assert.throws(() => editCatalogActress(input, { ...context, operationId: randomUUID() }),
    (error: unknown) => isStructuredError(error) && error.code === 'VERSION_CONFLICT')
  assert.throws(() => editCatalogActress({ ...input, fields: { main_name: 'Other' } }, context))
})

it('accepts legacy local edits without A but never ignores a supplied stale A', () => {
  const { actressId, context } = fixture()
  const input = { actressId, fields: { profile_summary: 'local' } }
  const unversioned = { ...context, expectedVersions: {} }
  assert.throws(() => editCatalogActress(input, unversioned),
    (error: unknown) => isStructuredError(error) && error.code === 'INVALID_INPUT')
  assert.equal(editCatalogActress(input, unversioned, true).data.ok, true)
  assert.throws(() => editCatalogActress(input, { ...context, operationId: randomUUID() }, true),
    (error: unknown) => isStructuredError(error) && error.code === 'VERSION_CONFLICT')
})

it('edits and clears a local avatar in the same revision as its profile', async () => {
  const { actressId, context } = fixture()
  const created = editCatalogActress({ actressId, fields: {
    main_name: 'With avatar', avatarImageBase64: (await image()).toString('base64')
  } }, context)
  assert.equal(created.data.versions.A.revision, context.expectedVersions.A.revision + 1)
  const avatar = getActressAvatarRecord(actressId)!
  assert.ok(avatar.avatar_path && avatar.avatar_source_path)
  const clear = editCatalogActress({ actressId, fields: { clearAvatar: true, profile_summary: 'cleared' } }, {
    ...context, operationId: randomUUID(), expectedVersions: created.data.versions
  })
  assert.equal(clear.data.versions.A.revision, created.data.versions.A.revision + 1)
  assert.equal(getActressAvatarRecord(actressId)?.avatar_path, null)
  assert.equal(fs.existsSync(mediaAssetStore.resolve(avatar.avatar_path)), false)
})

it('restores the original avatar and profile if name validation or image preparation fails', async () => {
  const { actressId, context } = fixture()
  const initial = editCatalogActress({ actressId, fields: {
    avatarImageBase64: (await image()).toString('base64')
  } }, context)
  upsertActressFromScrape('Occupied', null)
  const before = getDb().prepare('SELECT * FROM actresses WHERE id = ?').get(actressId)
  const avatar = getActressAvatarRecord(actressId)!
  const bytes = mediaAssetStore.readBytes(avatar.avatar_path!)
  for (const fields of [
    { main_name: 'Occupied', avatarImageBase64: (await image(200)).toString('base64') },
    { main_name: 'Otherwise valid', avatarImageBase64: Buffer.from('not an image').toString('base64') }
  ]) {
    const operationId = randomUUID()
    assert.throws(() => editCatalogActress({ actressId, fields }, {
      ...context, operationId, expectedVersions: initial.data.versions
    }))
    assert.deepEqual(getDb().prepare('SELECT * FROM actresses WHERE id = ?').get(actressId), before)
    assert.deepEqual(mediaAssetStore.readBytes(avatar.avatar_path!), bytes)
    assert.notEqual(readOperationReceipt(operationId)?.status, 'applied')
  }
})

it('combines an upload and profile edit once, then replays without consuming or writing again', async () => {
  const { actressId, identity, context } = fixture()
  const upload = createCatalogUpload({ purpose: 'actressAvatar', contentType: 'image/png',
    catalogId: identity.catalogId, writerEpoch: identity.writerEpoch })
  await completeCatalogUploadFromBuffer(upload.uploadId, await image(), {
    catalogId: identity.catalogId, writerEpoch: identity.writerEpoch, contentType: 'image/png'
  })
  const input = { actressId, fields: { main_name: 'Remote name' },
    avatarRef: { kind: 'upload' as const, uploadId: upload.uploadId } }
  const result = editCatalogActress(input, context)
  assert.equal(result.data.versions.A.revision, context.expectedVersions.A.revision + 1)
  assert.equal(readCatalogUpload(upload.uploadId)?.status, 'consumed')
  assert.ok(getActressAvatarRecord(actressId)?.avatar_path)
  assert.deepEqual(editCatalogActress(input, context).data, result.data)
  const clear = editCatalogActress({ actressId, fields: {}, avatarRef: { kind: 'clear' } }, {
    ...context, operationId: randomUUID(), expectedVersions: result.data.versions
  })
  assert.equal(clear.data.versions.A.revision, result.data.versions.A.revision + 1)
  assert.equal(getActressAvatarRecord(actressId)?.avatar_source_path, null)
})

it('keeps the upload retryable and the old avatar readable when an uploaded edit conflicts', async () => {
  const { actressId, identity, context } = fixture()
  const initial = editCatalogActress({ actressId, fields: {
    avatarImageBase64: (await image()).toString('base64')
  } }, context)
  upsertActressFromScrape('Occupied', null)
  const current = getActressAvatarRecord(actressId)!
  const originalBytes = mediaAssetStore.readBytes(current.avatar_path!)
  const upload = createCatalogUpload({ purpose: 'actressAvatar', contentType: 'image/png',
    catalogId: identity.catalogId, writerEpoch: identity.writerEpoch })
  await completeCatalogUploadFromBuffer(upload.uploadId, await image(200), {
    catalogId: identity.catalogId, writerEpoch: identity.writerEpoch, contentType: 'image/png'
  })
  const operationId = randomUUID()
  assert.throws(() => editCatalogActress({ actressId, fields: { main_name: 'Occupied' },
    avatarRef: { kind: 'upload', uploadId: upload.uploadId } }, {
    ...context, operationId, expectedVersions: initial.data.versions
  }))
  assert.deepEqual(readActressAggregateVersion(actressId), initial.data.versions.A)
  assert.deepEqual(getActressAvatarRecord(actressId), current)
  assert.deepEqual(mediaAssetStore.readBytes(current.avatar_path!), originalBytes)
  assert.equal(readCatalogUpload(upload.uploadId)?.status, 'ready')
  assert.notEqual(readOperationReceipt(operationId)?.status, 'applied')
})
