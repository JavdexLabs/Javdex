import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createMediaLibrary } from './mediaLibraryRepo'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import {
  PendingResourceIdentityRepoError,
  deletePendingResourceIdentity,
  getPendingResourceIdentityRecord,
  listPendingResourceIdentities,
  pendingResourceIdentityExists,
  reconcilePendingResourceIdentities,
  upsertPendingResourceIdentity
} from './pendingResourceIdentityRepo'

let temporaryDirectory: string | null = null

afterEach(() => {
  closeDatabase()
  if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = null
})

function setup(): { libraryId: number; rootId: number; rootPath: string } {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-nfo-identity-'))
  initDatabaseAtPath(path.join(temporaryDirectory, 'library.db'))
  const rootPath = path.join(temporaryDirectory, 'media')
  fs.mkdirSync(rootPath)
  const library = createMediaLibrary({ name: 'NFO', roots: [{ path: rootPath }] })
  return { libraryId: library.id, rootId: library.roots[0].id, rootPath }
}

function hasCode(code: PendingResourceIdentityRepoError['code']): (error: unknown) => boolean {
  return (error) => error instanceof PendingResourceIdentityRepoError && error.code === code
}

describe('pending resource identity repository', () => {
  it('persists the minimum conflict snapshot while exposing only safe presentation fields', () => {
    const library = setup()
    const filePath = path.join(library.rootPath, 'ABC-001.strm')
    fs.writeFileSync(filePath, 'https://example.test/watch?token=secret')
    const stat = fs.statSync(filePath)
    const created = upsertPendingResourceIdentity({
      ...library,
      filePath,
      sourceKind: 'strm',
      targetKind: 'web',
      targetLocator: 'https://example.test/watch?token=secret',
      targetKey: 'http:https://example.test/watch?token=secret',
      filenameCode: 'abc-001',
      nfoCode: 'xyz-002',
      sizeBytes: stat.size,
      fileMtimeMs: Math.round(stat.mtimeMs)
    })

    assert.equal(created.revision, 1)
    assert.equal(pendingResourceIdentityExists(library.libraryId, filePath), true)
    const visible = listPendingResourceIdentities(library.libraryId)[0]
    assert.equal(visible.filenameCode, 'ABC-001')
    assert.equal(visible.nfoCode, 'XYZ-002')
    assert.equal(visible.displayName, 'ABC-001.strm')
    assert.match(visible.targetDisplay!, /example\.test/u)
    assert.equal(JSON.stringify(visible).includes('token=secret'), false)
    assert.equal(JSON.stringify(visible).includes(library.rootPath), false)

    const stored = getPendingResourceIdentityRecord(library.libraryId, created.id)
    assert.equal(stored?.filePath, filePath)
    assert.equal(stored?.targetLocator?.includes('token=secret'), true)
    const columns = new Set(
      (getDb().prepare('PRAGMA table_info(pending_resource_identities)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    for (const forbidden of ['nfo_path', 'nfo_content', 'nfo_hash', 'nfo_mtime', 'processed']) {
      assert.equal(columns.has(forbidden), false)
    }
  })

  it('upserts one conflict per library path and enforces revision when deleting', () => {
    const library = setup()
    const filePath = path.join(library.rootPath, 'ABC-001.mp4')
    fs.writeFileSync(filePath, 'video')
    const input = {
      ...library,
      filePath,
      sourceKind: 'local' as const,
      filenameCode: 'ABC-001',
      nfoCode: 'XYZ-002',
      sizeBytes: 5,
      fileMtimeMs: 1
    }
    const first = upsertPendingResourceIdentity(input)
    const second = upsertPendingResourceIdentity({ ...input, sizeBytes: 6, fileMtimeMs: 2 })
    assert.equal(second.id, first.id)
    assert.equal(second.revision, 2)
    assert.equal(listPendingResourceIdentities(library.libraryId).length, 1)
    assert.throws(
      () => deletePendingResourceIdentity(library.libraryId, first.id, first.revision),
      hasCode('REVISION_CONFLICT')
    )
    assert.equal(deletePendingResourceIdentity(library.libraryId, second.id, second.revision), true)
  })

  it('rejects paths outside the root, equal identities, and malformed STRM snapshots', () => {
    const library = setup()
    const outside = path.join(temporaryDirectory!, 'outside.mp4')
    fs.writeFileSync(outside, 'x')
    const base = {
      ...library,
      filePath: outside,
      sourceKind: 'local' as const,
      filenameCode: 'ABC-001',
      nfoCode: 'XYZ-002',
      sizeBytes: 1,
      fileMtimeMs: 1
    }
    assert.throws(() => upsertPendingResourceIdentity(base), hasCode('ROOT_NOT_FOUND'))
    assert.throws(
      () => upsertPendingResourceIdentity({ ...base, filePath: path.join(library.rootPath, 'x.mp4'), nfoCode: 'abc-001' }),
      hasCode('VALIDATION_FAILED')
    )
    assert.throws(
      () =>
        upsertPendingResourceIdentity({
          ...base,
          filePath: path.join(library.rootPath, 'x.strm'),
          sourceKind: 'strm'
        }),
      hasCode('VALIDATION_FAILED')
    )
  })

  it('removes missing conflicts only under roots proven accessible by a safe scan', () => {
    const library = setup()
    const filePath = path.join(library.rootPath, 'ABC-001.mp4')
    fs.writeFileSync(filePath, 'video')
    upsertPendingResourceIdentity({
      ...library,
      filePath,
      sourceKind: 'local',
      filenameCode: 'ABC-001',
      nfoCode: 'XYZ-002',
      sizeBytes: 5,
      fileMtimeMs: 1
    })

    assert.deepEqual(
      reconcilePendingResourceIdentities(library.libraryId, [], () => 'missing'),
      { removed: 0 }
    )
    assert.deepEqual(
      reconcilePendingResourceIdentities(library.libraryId, [library.rootId], () => 'unknown'),
      { removed: 0 }
    )
    assert.deepEqual(
      reconcilePendingResourceIdentities(library.libraryId, [library.rootId], () => 'missing'),
      { removed: 1 }
    )
  })
})
