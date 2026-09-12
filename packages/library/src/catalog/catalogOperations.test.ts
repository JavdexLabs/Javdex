import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { isStructuredError } from '@shared/protocol/errors'
import { commitCatalogMutation, readOperationReceipt } from './catalogOperations'
import {
  assertExpectedVideoVersion,
  readVideoAggregateVersion
} from './catalogVideoVersion'
import { editVideoRecord } from '@library/db/videoRepo'
import { ensureCatalogIdentity } from './catalogIdentity'

let root: string | null = null

afterEach(() => {
  closeDatabase()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = null
})

describe('catalog operation receipts and video versions', () => {
  it('rejects a stale V, returns the original receipt on retry, and refuses a reused operation id', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s05-ops-'))
    const db = initDatabaseAtPath(path.join(root, 'library.db'))
    ensureCatalogIdentity({ catalogId: randomUUID() })
    const videoId = Number(getDb().prepare("INSERT INTO videos (code, title) VALUES ('S05-001', 'One')").run().lastInsertRowid)
    const version = readVideoAggregateVersion(videoId)!
    const operationId = randomUUID()
    const first = commitCatalogMutation({
      operationId,
      operation: 'videos.edit',
      expectedVersions: { V: version },
      input: { videoId, title: 'Two' },
      writerEpoch: 0
    }, () => {
      assertExpectedVideoVersion(videoId, { V: version }, operationId)
      editVideoRecord(videoId, { title: 'Two' })
      return {
        videoId,
        versions: { V: readVideoAggregateVersion(videoId)! }
      }
    })
    assert.equal(first.outcome, 'applied')
    assert.equal(first.data.versions.V.revision, version.revision + 1)
    const stale = readVideoAggregateVersion(videoId)!
    assert.throws(
      () =>
        commitCatalogMutation({
          operationId: randomUUID(),
          operation: 'videos.edit',
          expectedVersions: { V: version },
          input: { videoId, title: 'Three' },
          writerEpoch: 0
        }, () => {
          assertExpectedVideoVersion(videoId, { V: version })
          editVideoRecord(videoId, { title: 'Three' })
          return { videoId }
        }),
      (error: unknown) => isStructuredError(error) && error.code === 'VERSION_CONFLICT'
    )
    const retry = commitCatalogMutation({
      operationId,
      operation: 'videos.edit',
      expectedVersions: { V: version },
      input: { videoId, title: 'Two' },
      writerEpoch: 0
    }, () => {
      throw new Error('must not run again')
    })
    assert.equal(retry.outcome, 'duplicate')
    assert.deepEqual(retry.data.versions, first.data.versions)
    assert.throws(
      () =>
        commitCatalogMutation({
          operationId,
          operation: 'videos.edit',
          expectedVersions: { V: stale },
          input: { videoId, title: 'Other' },
          writerEpoch: 0
        }, () => {
          throw new Error('must not run')
        }),
      (error: unknown) => isStructuredError(error) && error.code === 'OPERATION_KEY_REUSED'
    )
    const stored = readOperationReceipt(operationId)
    assert.equal(stored?.status, 'applied')
    assert.equal(readVideoAggregateVersion(videoId)?.revision, first.data.versions.V.revision)
  })
})
