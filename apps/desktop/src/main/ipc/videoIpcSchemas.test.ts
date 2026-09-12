import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { IPC } from '@shared/ipc-channels'
import { mediaLibraryIpcSchemas } from './mediaLibraryIpcSchemas'
import { videoIpcSchemas } from './ipcCommandSchemas'

const libraryScope = { kind: 'library' as const, libraryId: 3 }

const completeVideoQuery = {
  search: '  ABC-123  ',
  scrapedStatus: 2 as const,
  minRating: 4.5,
  year: 2026,
  actressId: 11,
  tagId: 12,
  tagIds: [13, 14],
  makerOrganizationId: 15,
  publisherOrganizationId: 16,
  seriesId: 17,
  directorId: 18,
  codePrefix: '  ABC  ',
  resourceKinds: ['local', 'direct', 'web', 'magnet', 'ed2k', 'none'] as const,
  pendingScrape: 'pending' as const,
  sortBy: 'release_date' as const,
  sortDir: 'desc' as const,
  limit: 200,
  offset: Number.MAX_SAFE_INTEGER
}

describe('video query IPC schemas', () => {
  it('accepts and normalizes a complete list query at every VideoQuery boundary', () => {
    const listResult = videoIpcSchemas[IPC.VIDEO_LIST].safeParse([
      libraryScope,
      completeVideoQuery
    ])
    assert.equal(listResult.success, true)
    if (listResult.success) {
      assert.equal((listResult.data[1] as { search?: string }).search, 'ABC-123')
      assert.equal((listResult.data[1] as { codePrefix?: string }).codePrefix, 'ABC')
    }

    assert.equal(
      mediaLibraryIpcSchemas[IPC.HOME_SEARCH].safeParse([
        { ...completeVideoQuery, libraryIds: [3, 7] }
      ]).success,
      true
    )
  })

  it('rejects malformed fields consistently for lists and global search', () => {
    const invalidQueries: unknown[] = [
      { search: 123 },
      { search: 'x'.repeat(501) },
      { scrapedStatus: 3 },
      { pendingScrape: 'queued' },
      { minRating: Number.NaN },
      { minRating: -0.1 },
      { minRating: 5.1 },
      { year: 1900 },
      { year: 2026.5 },
      { year: 10_000 },
      { actressId: 0 },
      { tagId: -1 },
      { makerOrganizationId: 1.5 },
      { publisherOrganizationId: Number.MAX_SAFE_INTEGER + 1 },
      { seriesId: '1' },
      { directorId: null },
      { tagIds: [2, 2] },
      { tagIds: Array.from({ length: 101 }, (_, index) => index + 1) },
      { tagIds: [0] },
      { codePrefix: 'x'.repeat(101) },
      { resourceKinds: ['local', 'local'] },
      { resourceKinds: ['ftp'] },
      { sortBy: 'title' },
      { sortDir: 'newest' },
      { limit: 0 },
      { limit: 201 },
      { limit: 1.5 },
      { offset: -1 },
      { offset: 1.5 },
      { offset: Number.MAX_SAFE_INTEGER + 1 },
      { rawSql: 'SELECT 1' }
    ]

    for (const query of invalidQueries) {
      assert.equal(
        videoIpcSchemas[IPC.VIDEO_LIST].safeParse([libraryScope, query]).success,
        false,
        `VIDEO_LIST accepted ${JSON.stringify(query)}`
      )
      assert.equal(
        mediaLibraryIpcSchemas[IPC.HOME_SEARCH].safeParse([query]).success,
        false,
        `HOME_SEARCH accepted ${JSON.stringify(query)}`
      )
    }
  })

  it('strictly validates catalog scopes and video detail identifiers', () => {
    const listSchema = videoIpcSchemas[IPC.VIDEO_LIST]
    const getSchema = videoIpcSchemas[IPC.VIDEO_GET]

    assert.equal(listSchema.safeParse([libraryScope]).success, true)
    assert.equal(listSchema.safeParse([{ kind: 'all' }, {}]).success, true)
    assert.equal(
      listSchema.safeParse([{ kind: 'all', libraryIds: [3, 7] }, {}]).success,
      true
    )
    assert.equal(getSchema.safeParse([libraryScope, 42]).success, true)

    for (const scope of [
      { kind: 'library', libraryId: 0 },
      { kind: 'library', libraryId: Number.MAX_SAFE_INTEGER + 1 },
      { kind: 'library', libraryId: 3, unexpected: true },
      { kind: 'all', libraryIds: [3, 3] },
      { kind: 'all', libraryIds: [Number.MAX_SAFE_INTEGER + 1] },
      { kind: 'unknown' }
    ]) {
      assert.equal(listSchema.safeParse([scope, {}]).success, false)
      assert.equal(getSchema.safeParse([scope, 42]).success, false)
    }

    for (const videoId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '42']) {
      assert.equal(getSchema.safeParse([libraryScope, videoId]).success, false)
    }
    assert.equal(getSchema.safeParse([libraryScope, 42, 'unexpected']).success, false)
  })
})
