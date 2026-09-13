import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import type { CatalogBackend } from '../../application/catalogBackend'
import { createMemoryPlaylistImportCatalogLookup } from './playlistImportCatalogLookup'
import { applyPlaylistImportThroughCatalog } from './playlistImportCatalogApply'
import { PlaylistImportRepository } from './playlistImportRepository'

describe('playlistImportCatalogLookup', () => {
  it('matches catalog videos by normalized code from videos.list/get', async () => {
    const lookup = createMemoryPlaylistImportCatalogLookup()
    const listed: unknown[] = []
    const catalog = {
      queries: {
        listVideos: async (input: { query?: { search?: string } }) => {
          listed.push(input.query?.search)
          return {
            items: [
              { id: 11, code: 'ABC-001' },
              { id: 12, code: 'ABC-0012' }
            ]
          }
        },
        getVideo: async (input: { videoId: number }) => {
          if (input.videoId === 11) {
            return {
              id: 11,
              code: 'ABC-001',
              title: 'Keep',
              publisher: 'Studio',
              publisher_organization_id: 4,
              release_date: '2024-01-02',
              libraries: [{ libraryId: 1, name: '主库' }],
              links: [{ label: 'list', url: 'https://example.test/video/abc-001' }],
              resources: [{ kind: 'local' }]
            }
          }
          return {
            id: 12,
            code: 'ABC-0012',
            title: 'Other',
            libraries: [],
            links: []
          }
        }
      }
    } as unknown as CatalogBackend
    await lookup.ingestCodes(catalog, ['abc-001'])
    assert.deepEqual(listed, ['ABC-001'])
    const matches = lookup.videosByCode('ABC-001')
    assert.equal(matches.length, 1)
    assert.equal(matches[0]?.videoId, 11)
    assert.deepEqual(matches[0]?.libraryIds, [1])
    assert.deepEqual(matches[0]?.resourceKinds, ['local'])
    assert.equal(
      lookup.videosByDetailUrl('https://example.test/video/abc-001').length,
      1
    )
  })
})

describe('playlistImport catalog apply', () => {
  it('creates the playlist through playlists.applyImport and does not need catalog SQL tables', async () => {
    const database = new Database(':memory:')
    const lookup = createMemoryPlaylistImportCatalogLookup()
    await lookup.ingestCodes(
      {
        queries: {
          listVideos: async () => ({ items: [{ id: 20, code: 'AAA-1' }] }),
          getVideo: async () => ({
            id: 20,
            code: 'AAA-1',
            title: 'Existing',
            generation: 1,
            revision: 3,
            libraries: [{ libraryId: 1, name: '主库' }],
            links: []
          })
        }
      } as unknown as CatalogBackend,
      ['AAA-1']
    )
    const repository = new PlaylistImportRepository(database, lookup)
    repository.createJob({
      runId: 'run-remote-apply',
      idempotencyKey: 'remote-apply',
      sourceUrl: 'https://example.test/list',
      targetLibraryId: 1,
      destination: { kind: 'create', requestedName: '导入清单' },
      targetLibrary: { id: 1, name: '主库' },
      autoCreateUnmatchedVideos: false
    })
    const preview = repository.checkpointStaticPage({
      runId: 'run-remote-apply',
      pageKey: 'page-0',
      pageOrder: 0,
      pageUrl: 'https://example.test/list',
      documentRevision: '1:1',
      viewRevision: '1:1:0',
      evidenceRef: 'evidence',
      items: [{ code: 'AAA-1', detailUrl: 'https://example.test/video/aaa-1' }],
      nextPageUrls: [],
      terminal: true
    })
    assert.equal(preview.phase, 'ready-to-apply')
    const calls: string[] = []
    const catalog = {
      mode: 'remote',
      libraries: {
        get: async () => ({ id: 1, name: '主库', status: 'active', revision: 8 })
      },
      queries: {
        getVideo: async () => ({ id: 20, generation: 1, revision: 3 })
      },
      playlists: {
        applyImport: async (input: { videoIds: number[] }, ctx: { operationId: string }) => {
          calls.push(`apply:${input.videoIds.join(',')}:${ctx.operationId}`)
          return { playlistId: 99, added: 1 }
        },
        get: async () => ({ id: 99, name: '导入清单' })
      },
      tasks: {
        getOperation: async () => null
      }
    } as unknown as CatalogBackend
    const outcome = await applyPlaylistImportThroughCatalog(
      catalog,
      repository,
      'run-remote-apply',
      'apply-1'
    )
    assert.equal(outcome.playlistId, 99)
    assert.equal(outcome.reusedVideos, 1)
    assert.equal(outcome.createdVideos, 0)
    assert.equal(calls.length, 1)
    assert.equal(repository.snapshot('run-remote-apply')?.phase, 'completed')
  })

  it('retries playlists.applyImport with the stored operation id after a lost response', async () => {
    const database = new Database(':memory:')
    const lookup = createMemoryPlaylistImportCatalogLookup()
    await lookup.ingestCodes(
      {
        queries: {
          listVideos: async () => ({ items: [{ id: 20, code: 'AAA-1' }] }),
          getVideo: async () => ({
            id: 20,
            code: 'AAA-1',
            generation: 1,
            revision: 3,
            libraries: [{ libraryId: 1, name: '主库' }],
            links: [],
            resources: [{ kind: 'local' }]
          })
        }
      } as unknown as CatalogBackend,
      ['AAA-1']
    )
    const repository = new PlaylistImportRepository(database, lookup)
    repository.createJob({
      runId: 'run-remote-retry',
      idempotencyKey: 'remote-retry',
      sourceUrl: 'https://example.test/list',
      targetLibraryId: 1,
      destination: { kind: 'create', requestedName: '导入清单' },
      targetLibrary: { id: 1, name: '主库' },
      autoCreateUnmatchedVideos: false
    })
    repository.checkpointStaticPage({
      runId: 'run-remote-retry',
      pageKey: 'page-0',
      pageOrder: 0,
      pageUrl: 'https://example.test/list',
      documentRevision: '1:1',
      viewRevision: '1:1:0',
      evidenceRef: 'evidence',
      items: [{ code: 'AAA-1', detailUrl: 'https://example.test/video/aaa-1' }],
      nextPageUrls: [],
      terminal: true
    })
    const operationIds: string[] = []
    let attempts = 0
    const catalog = {
      mode: 'remote',
      libraries: {
        get: async () => ({ id: 1, name: '主库', status: 'active', revision: 8 })
      },
      queries: {
        getVideo: async () => ({ id: 20, generation: 1, revision: 3 })
      },
      playlists: {
        applyImport: async (_input: { videoIds: number[] }, ctx: { operationId: string }) => {
          attempts += 1
          operationIds.push(ctx.operationId)
          if (attempts === 1) throw new Error('CONNECTION_UNAVAILABLE')
          return { playlistId: 77, added: 1 }
        },
        get: async () => ({ id: 77, name: '导入清单' })
      }
    } as unknown as CatalogBackend
    await assert.rejects(
      () => applyPlaylistImportThroughCatalog(catalog, repository, 'run-remote-retry', 'apply-retry'),
      /CONNECTION_UNAVAILABLE/
    )
    const outcome = await applyPlaylistImportThroughCatalog(
      catalog,
      repository,
      'run-remote-retry',
      'apply-retry'
    )
    assert.equal(outcome.playlistId, 77)
    assert.equal(attempts, 2)
    assert.equal(operationIds.length, 2)
    assert.equal(operationIds[0], operationIds[1])
  })
})
