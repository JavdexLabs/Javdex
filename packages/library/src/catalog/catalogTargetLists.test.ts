import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { isStructuredError } from '@shared/protocol/errors'
import {
  createCatalogTargetList,
  pageCatalogTargetList,
  targetListFilterDigest,
  targetListRequestDigest
} from './catalogTargetLists'

let root: string | null = null

function setup(): ReturnType<typeof getDb> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-c6-target-list-'))
  initDatabaseAtPath(path.join(root, 'library.db'))
  return getDb()
}

afterEach(() => {
  closeDatabase()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = null
})

function insertVideo(code: string): number {
  return Number(getDb().prepare('INSERT INTO videos (code) VALUES (?)').run(code).lastInsertRowid)
}

describe('catalog target lists', () => {
  it('freezes explicit ids and keeps deleted placeholders', () => {
    setup()
    const first = insertVideo('C6-A')
    const second = insertVideo('C6-B')
    const digest = targetListRequestDigest({ kind: 'videos.ids', ids: [first, second] })
    const created = createCatalogTargetList({
      kind: 'videos.ids',
      filterDigest: digest,
      ids: [first, second]
    })
    assert.equal(created.count, 2)
    getDb().prepare('DELETE FROM videos WHERE id = ?').run(second)
    const page = pageCatalogTargetList({ targetListId: created.targetListId })
    assert.deepEqual(page.ids, [first, second])
    assert.equal(page.entries.length, 2)
    assert.equal(page.entries[0]?.present, true)
    assert.equal(page.entries[0]?.label, 'C6-A')
    assert.equal(page.entries[1]?.present, false)
    assert.equal(page.entries[1]?.label, 'C6-B')
  })

  it('freezes a video filter snapshot so later inserts stay out', () => {
    setup()
    insertVideo('C6-ONE')
    const videoFilter = { status: 'all' as const }
    const digest = targetListRequestDigest({ kind: 'videos.filter', videoFilter })
    const created = createCatalogTargetList({
      kind: 'videos.filter',
      filterDigest: digest,
      videoFilter
    })
    assert.equal(created.count, 1)
    insertVideo('C6-TWO')
    const page = pageCatalogTargetList({ targetListId: created.targetListId })
    assert.equal(page.ids.length, 1)
    assert.equal(page.hasMore, false)
  })

  it('keeps named kind digest-of-evaluated-ids compatibility', () => {
    setup()
    insertVideo('C6-NAMED')
    const digest = targetListFilterDigest('videos.status:all')
    const created = createCatalogTargetList({ kind: 'videos.status:all', filterDigest: digest })
    assert.equal(created.count, 1)
    assert.throws(
      () => createCatalogTargetList({ kind: 'videos.status:all', filterDigest: '0'.repeat(64) }),
      (error: unknown) => isStructuredError(error) && error.code === 'VERSION_CONFLICT'
    )
  })

  it('rejects combining ids with a filter payload', () => {
    setup()
    assert.throws(
      () =>
        createCatalogTargetList({
          kind: 'videos.ids',
          filterDigest: targetListRequestDigest({ kind: 'videos.ids', ids: [1] }),
          ids: [1],
          videoFilter: { status: 'all' }
        }),
      (error: unknown) => isStructuredError(error) && error.message.includes('不能同时')
    )
  })
})
