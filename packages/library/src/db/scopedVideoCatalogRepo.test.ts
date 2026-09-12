import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateDatabase } from './migrations'
import { createScopedVideoCatalogRepo } from './scopedVideoCatalogRepo'

function createFixture(verbose?: (sql: string) => void): Database.Database {
  const database = new Database(
    ':memory:',
    verbose ? { verbose: (message) => verbose(String(message)) } : undefined
  )
  database.pragma('foreign_keys = ON')
  migrateDatabase(database)
  database.exec(`
    INSERT INTO media_libraries (
      id, name, icon, color, position, status, is_default, revision
    ) VALUES (2, '收藏库', 'star', 'amber', 1, 'active', 0, 1);
    INSERT INTO media_library_configs (library_id) VALUES (2);

    INSERT INTO videos (id, code, title, release_date, rating, add_time)
    VALUES
      (101, 'ABC-101', 'Shared video', '2024-02-03', 4, '2024-01-01T00:00:00.000Z'),
      (102, 'ABC-102', 'Only in B', '2023-04-05', 2, '2024-01-02T00:00:00.000Z');

    INSERT INTO library_video_memberships (
      library_id, video_id, added_at, updated_at, added_via, discovery_key
    ) VALUES
      (1, 101, '2024-05-01T00:00:00.000Z', '2024-05-01T00:00:00.000Z', 'scan', 101),
      (2, 101, '2024-06-01T00:00:00.000Z', '2024-06-01T00:00:00.000Z', 'shared', 201),
      (2, 102, '2024-07-01T00:00:00.000Z', '2024-07-01T00:00:00.000Z', 'scan', 202);

    INSERT INTO video_resources (
      id, library_id, video_id, kind, locator, resource_key, is_primary
    ) VALUES
      (1001, 1, 101, 'web', 'https://a.example/watch', 'web:a', 1),
      (1002, 2, 101, 'direct', 'https://b.example/file', 'direct:b', 1);
  `)
  return database
}

function seedLargeScopedCatalog(database: Database.Database, count = 1_000): void {
  const insertVideo = database.prepare(
    'INSERT INTO videos (id, code, title) VALUES (?, ?, ?)'
  )
  const insertMembership = database.prepare(
    `INSERT INTO library_video_memberships (
       library_id, video_id, added_at, updated_at, added_via, discovery_key
     ) VALUES (1, ?, ?, ?, 'scan', ?)`
  )
  const insertResource = database.prepare(
    `INSERT INTO video_resources (
       library_id, video_id, kind, locator, resource_key, is_primary
     ) VALUES (1, ?, 'web', ?, ?, 1)`
  )
  database.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const videoId = 1_000 + index
      const addedAt = new Date(Date.UTC(2026, 2, 1, 0, 0, index)).toISOString()
      insertVideo.run(videoId, `SCOPED-${String(index).padStart(4, '0')}`, `Scoped ${index}`)
      insertMembership.run(videoId, addedAt, addedAt, index + 1)
      insertResource.run(
        videoId,
        `https://scope.example.test/${videoId}`,
        `web:scope-${videoId}`
      )
    }
  })()
}

function selectStatements(trace: string[]): string[] {
  return trace
    .map((statement) => statement.trim())
    // Revision reads are constant-cost bookkeeping, counted separately from catalog work.
    .filter((statement) => /^(SELECT|WITH)\b/i.test(statement) && !statement.includes('AS revision_changes'))
}

function explainPlan(database: Database.Database, statement: string): string {
  return (
    database.prepare(`EXPLAIN QUERY PLAN ${statement}`).all() as Array<{ detail: string }>
  )
    .map((row) => row.detail)
    .join('\n')
}

describe('scoped video catalog repo', () => {
  it('keeps list resources and membership time inside one library', () => {
    const database = createFixture()
    try {
      const repo = createScopedVideoCatalogRepo(database)
      const result = repo.list({ kind: 'library', libraryId: 1 })
      assert.equal(result.total, 1)
      assert.deepEqual(
        result.items.map((video) => ({
          id: video.id,
          preferredLibraryId: video.preferredLibraryId,
          membershipAddedAt: video.membershipAddedAt,
          primary: video.primary_resource_kind,
          resources: video.resource_count,
          libraries: video.libraries.map((library) => library.libraryId)
        })),
        [
          {
            id: 101,
            preferredLibraryId: 1,
            membershipAddedAt: '2024-05-01T00:00:00.000Z',
            primary: 'web',
            resources: 1,
            libraries: [1, 2]
          }
        ]
      )
    } finally {
      database.close()
    }
  })

  it('loads detail from the injected database and projects only the active library resources', () => {
    const database = createFixture()
    try {
      const repo = createScopedVideoCatalogRepo(database)
      const detail = repo.get({ kind: 'library', libraryId: 2 }, 101)
      assert.ok(detail)
      assert.equal(detail.activeLibraryId, 2)
      assert.deepEqual(detail.resources.map((resource) => resource.id), [1002])
      assert.deepEqual(detail.libraries.map((library) => library.libraryId), [1, 2])
    } finally {
      database.close()
    }
  })

  it('deduplicates global results and selects the newest eligible membership', () => {
    const database = createFixture()
    try {
      const repo = createScopedVideoCatalogRepo(database)
      const result = repo.list({ kind: 'all' }, { sortBy: 'add_time', sortDir: 'desc' })
      assert.equal(result.total, 2)
      assert.deepEqual(
        result.items.map((video) => [video.id, video.preferredLibraryId, video.resource_count]),
        [
          [102, 2, 0],
          [101, 2, 1]
        ]
      )
      assert.equal(result.items[1]?.primary_resource_kind, 'direct')
    } finally {
      database.close()
    }
  })

  it('interprets the none resource filter within the selected scope', () => {
    const database = createFixture()
    try {
      const repo = createScopedVideoCatalogRepo(database)
      assert.deepEqual(
        repo
          .list({ kind: 'library', libraryId: 2 }, { resourceKinds: ['none'] })
          .items.map((video) => video.id),
        [102]
      )
      assert.deepEqual(repo.listYears({ kind: 'library', libraryId: 1 }), [2024])
      assert.deepEqual(repo.listYears({ kind: 'library', libraryId: 2 }), [2024, 2023])
    } finally {
      database.close()
    }
  })

  it('treats an archived media-library scope as unavailable', () => {
    const database = createFixture()
    try {
      database.prepare("UPDATE media_libraries SET status = 'archived' WHERE id = 2").run()
      const repo = createScopedVideoCatalogRepo(database)

      const archivedPage = repo.list({ kind: 'library', libraryId: 2 })
      assert.equal(typeof archivedPage.readRevision, 'string')
      const { readRevision: _readRevision, ...archivedBusiness } = archivedPage
      assert.deepEqual(archivedBusiness, {
        items: [],
        total: 0
      })
      assert.deepEqual(repo.listByIds({ kind: 'library', libraryId: 2 }, [101, 102]), [])
      assert.equal(repo.get({ kind: 'library', libraryId: 2 }, 101), null)
      assert.deepEqual(repo.listYears({ kind: 'library', libraryId: 2 }), [])
    } finally {
      database.close()
    }
  })

  it('rejects invalid scope ids before building SQL', () => {
    const database = createFixture()
    try {
      const repo = createScopedVideoCatalogRepo(database)
      assert.throws(() => repo.list({ kind: 'library', libraryId: 0 }), /正整数/)
      assert.throws(() => repo.list({ kind: 'all', libraryIds: [1, -2] }), /正整数/)
    } finally {
      database.close()
    }
  })

  it('keeps fixed actor and tag filters unique across shared and hidden memberships', () => {
    const database = createFixture()
    try {
      database.exec(`
        INSERT INTO actresses (id, main_name) VALUES (1, 'Example');
        INSERT INTO tags (id, name) VALUES (1, 'One'), (2, 'Two');
        INSERT INTO video_actress (video_id, actress_id) VALUES (101, 1), (102, 1);
        INSERT INTO video_tag (video_id, tag_id) VALUES (101, 1), (101, 2), (102, 1);
      `)
      const repo = createScopedVideoCatalogRepo(database)
      const query = { actressId: 1, tagId: 1, tagIds: [1, 2] }
      assert.equal(repo.list({ kind: 'all' }, query).total, 1)
      assert.deepEqual(repo.list({ kind: 'all' }, query).items.map(v => v.id), [101])
      assert.deepEqual(repo.list({ kind: 'all' }, { ...query, offset: 1 }).items, [])
      database.exec('UPDATE library_video_memberships SET is_hidden = 1 WHERE library_id = 2 AND video_id = 101')
      assert.equal(repo.list({ kind: 'all' }, query).items[0].preferredLibraryId, 1)
      database.exec('UPDATE library_video_memberships SET is_hidden = 1 WHERE video_id = 101')
      assert.equal(repo.list({ kind: 'all' }, query).total, 0)
    } finally {
      database.close()
    }
  })

  it('normalizes a single active library and serves no-count pages with identical ordering', () => {
    const trace: string[] = []
    const database = createFixture(sql => trace.push(sql))
    try {
      database.exec("UPDATE media_libraries SET status = 'archived' WHERE id = 1")
      const repo = createScopedVideoCatalogRepo(database)
      for (const sortBy of ['add_time', 'code', 'rating', 'release_date'] as const) {
        for (const sortDir of ['asc', 'desc'] as const) {
          const query = { sortBy, sortDir, limit: 1, offset: 1 }
          const expected = repo.list({ kind: 'library', libraryId: 2 }, query)
          trace.length = 0
          assert.deepEqual(repo.listPage({ kind: 'all' }, query), expected.items)
          assert.equal(trace.some(sql => /COUNT\(\*\) AS count|ROW_NUMBER/i.test(sql)), false)
        }
      }
    } finally {
      database.close()
    }
  })

  it('uses bounded indexed queries for a large scoped page', () => {
    const trace: string[] = []
    const database = createFixture((sql) => trace.push(sql))
    try {
      seedLargeScopedCatalog(database)
      trace.length = 0
      const repo = createScopedVideoCatalogRepo(database)
      const result = repo.list(
        { kind: 'library', libraryId: 1 },
        { sortBy: 'add_time', sortDir: 'desc', limit: 100, offset: 100 }
      )

      assert.equal(result.total, 1_001)
      assert.equal(result.items.length, 100)
      assert.equal(new Set(result.items.map((video) => video.id)).size, 100)
      const statements = selectStatements(trace)
      assert.equal(statements.length, 2)
      assert.equal(statements.some((statement) => /ORDER\s+BY\s+RANDOM\s*\(/i.test(statement)), false)
      const pageStatement = statements.find((statement) =>
        statement.includes('WITH page AS MATERIALIZED')
      )
      assert.ok(pageStatement)
      const plan = explainPlan(database, pageStatement)
      assert.match(plan, /idx_library_video_memberships_library_added/)
      assert.match(plan, /idx_video_resources_library_video_kind/)
    } finally {
      database.close()
    }
  })
})

it('reuses count across pages and sort while isolating scope/filter/page and caller mutations', () => {
  const trace: string[] = [], database = createFixture(sql => trace.push(sql))
  try {
    const repo = createScopedVideoCatalogRepo(database), scope = { kind: 'library' as const, libraryId: 2 }
    trace.length = 0
    const first = repo.list(scope, { limit: 1, offset: 0 })
    const expectedId = first.items[0].id
    first.items[0].title = 'caller mutation'; first.items[0].libraries.length = 0
    const second = repo.list(scope, { limit: 1, offset: 1, sortBy: 'code' })
    assert.equal(second.total, 2)
    const cached = repo.list(scope, { limit: 1, offset: 0 })
    assert.equal(cached.items[0].id, expectedId)
    assert.notEqual(cached.items[0].title, 'caller mutation')
    assert.ok(cached.items[0].libraries.length)
    assert.equal(trace.filter(sql => /^\s*SELECT COUNT\(\*\) AS count FROM library_video_memberships/.test(sql)).length, 1)
    assert.equal(trace.filter(sql => /WITH page AS MATERIALIZED/.test(sql)).length, 2)
    assert.equal(repo.list({ kind: 'library', libraryId: 1 }).total, 1)
    assert.equal(repo.list(scope, { year: 2023 }).total, 1)
    assert.equal(createScopedVideoCatalogRepo(database), repo)
    database.transaction(() => {
      database.exec('UPDATE library_video_memberships SET is_hidden=1 WHERE library_id=2 AND video_id=102')
      assert.equal(repo.list(scope).total, 1)
    })()
    assert.equal(repo.list(scope).total, 1)
  } finally { database.close() }
})
