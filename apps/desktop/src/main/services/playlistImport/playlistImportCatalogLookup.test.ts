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
        },
        listVideoSources: async (input: { videoIds?: number[] }) => ({
          items: (input.videoIds ?? []).map((videoId) => ({
            videoId,
            sources:
              videoId === 11
                ? [{ source: 'JavBus', externalCode: 'ABC-001', url: 'https://javbus.com/abc-001' }]
                : []
          }))
        })
      }
    } as unknown as CatalogBackend
    await lookup.ingestCodes(catalog, ['abc-001'])
    assert.deepEqual(listed, ['ABC-001'])
    const matches = lookup.videosByCode('ABC-001')
    assert.equal(matches.length, 1)
    assert.equal(matches[0]?.videoId, 11)
    assert.deepEqual(matches[0]?.libraryIds, [1])
    assert.deepEqual(matches[0]?.resourceKinds, ['local'])
    assert.deepEqual(matches[0]?.sources, [
      { source: 'JavBus', externalCode: 'ABC-001', url: 'https://javbus.com/abc-001' }
    ])
    assert.equal(
      lookup.videosBySourceIdentity({ source: 'javbus', externalCode: 'abc-001' })[0]?.videoId,
      11
    )
    assert.equal(
      lookup.videosByDetailUrl('https://example.test/video/abc-001').length,
      1
    )
  })

  it('rejects a handshake-shaped videos.list payload as a catalog read', async () => {
    const lookup = createMemoryPlaylistImportCatalogLookup()
    await assert.rejects(
      () =>
        lookup.ingestCodes(
          {
            queries: {
              listVideos: async () => ({ protocolVersion: 1, identity: { catalogId: 'catalog-1' } })
            }
          } as unknown as CatalogBackend,
          ['ABC-001']
        ),
      /影片列表响应无效/
    )
  })

  it('rejects an invalid videos.sources payload instead of matching empty sources', async () => {
    const lookup = createMemoryPlaylistImportCatalogLookup()
    await assert.rejects(
      () =>
        lookup.ingestCodes(
          {
            queries: {
              listVideos: async () => ({ items: [{ id: 11, code: 'ABC-001' }] }),
              getVideo: async () => ({ id: 11, code: 'ABC-001', libraries: [], links: [] }),
              listVideoSources: async () => ({ protocolVersion: 1 })
            }
          } as unknown as CatalogBackend,
          ['ABC-001']
        ),
      /来源查询响应无效/
    )
  })

  it('ingests source identity from videos.sources without opening a local library', async () => {
    const lookup = createMemoryPlaylistImportCatalogLookup()
    await lookup.ingestSourceIdentity(
      {
        queries: {
          listVideoSources: async (input: { source?: string; externalCode?: string }) => {
            assert.equal(input.source, 'JavBus')
            assert.equal(input.externalCode, 'ABC-001')
            return {
              items: [
                {
                  videoId: 31,
                  code: 'ABC-001',
                  sources: [{ source: 'JavBus', externalCode: 'ABC-001', url: null }]
                }
              ]
            }
          }
        }
      } as unknown as CatalogBackend,
      { source: 'JavBus', externalCode: 'ABC-001' }
    )
    assert.equal(
      lookup.videosBySourceIdentity({ source: 'javbus', externalCode: 'abc-001' })[0]?.videoId,
      31
    )
  })

  it('queries and merges external-code and source-url identities when both are present', async () => {
    const lookup = createMemoryPlaylistImportCatalogLookup()
    const queries: unknown[] = []
    await lookup.ingestSourceIdentity(
      {
        queries: {
          listVideoSources: async (input: {
            source?: string
            externalCode?: string
            url?: string
          }) => {
            queries.push(input)
            if (input.externalCode) {
              return {
                items: [{
                  videoId: 41,
                  code: 'BOTH-041',
                  sources: [{ source: 'JavBus', externalCode: 'BOTH-041', url: null }]
                }]
              }
            }
            return {
              items: [
                {
                  videoId: 41,
                  code: 'BOTH-041',
                  sources: [{ source: 'JavBus', externalCode: 'BOTH-041', url: 'https://javbus.com/both-041' }]
                },
                {
                  videoId: 42,
                  code: 'BOTH-042',
                  sources: [{ source: 'JavBus', externalCode: 'BOTH-042', url: 'https://javbus.com/both-041' }]
                }
              ]
            }
          }
        }
      } as unknown as CatalogBackend,
      {
        source: 'JavBus',
        externalCode: 'BOTH-041',
        sourceUrl: 'https://javbus.com/both-041'
      }
    )
    assert.deepEqual(queries, [
      { source: 'JavBus', externalCode: 'BOTH-041', limit: 50, offset: 0 },
      { source: 'JavBus', url: 'https://javbus.com/both-041', limit: 50, offset: 0 }
    ])
    assert.deepEqual(
      lookup.videoById(41)?.sources,
      [
        { source: 'JavBus', externalCode: 'BOTH-041', url: null },
        { source: 'JavBus', externalCode: 'BOTH-041', url: 'https://javbus.com/both-041' }
      ]
    )
    assert.equal(lookup.videoById(42)?.code, 'BOTH-042')
  })

  it('walks every source page when a source identity has more than one page of matches', async () => {
    const lookup = createMemoryPlaylistImportCatalogLookup()
    const pages: Array<{ limit?: number; offset?: number }> = []
    await lookup.ingestSourceIdentity(
      {
        queries: {
          listVideoSources: async (input: {
            source?: string
            externalCode?: string
            limit?: number
            offset?: number
          }) => {
            pages.push({ limit: input.limit, offset: input.offset })
            assert.equal(input.source, 'JavBus')
            assert.equal(input.externalCode, 'MANY-001')
            const offset = input.offset ?? 0
            const count = offset === 0 ? 50 : 1
            return {
              total: 51,
              items: Array.from({ length: count }, (_, index) => {
                const videoId = offset + index + 1
                return {
                  videoId,
                  code: videoId === 51 ? 'MANY-001' : `MANY-${String(videoId).padStart(3, '0')}`,
                  sources: [{
                    source: 'JavBus',
                    externalCode: videoId === 51 ? 'MANY-001' : `MANY-${String(videoId).padStart(3, '0')}`,
                    url: null
                  }]
                }
              })
            }
          }
        }
      } as unknown as CatalogBackend,
      { source: 'JavBus', externalCode: 'MANY-001' }
    )
    assert.deepEqual(pages, [
      { limit: 50, offset: 0 },
      { limit: 50, offset: 50 }
    ])
    assert.equal(lookup.videoById(51)?.code, 'MANY-001')
    assert.equal(
      lookup.videosBySourceIdentity({ source: 'javbus', externalCode: 'many-001' })
        .some((video) => video.videoId === 51),
      true
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
          }),
          listVideoSources: async () => ({ items: [{ videoId: 20, sources: [] }] })
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
        applyImport: async (
          input: {
            entries: Array<{ kind: 'existing' | 'create'; videoId?: number; links?: Array<{ label: string; url: string }> }>
          },
          ctx: { operationId: string }
        ) => {
          calls.push(`apply:${input.entries.map((entry) => entry.videoId ?? entry.kind).join(',')}:${ctx.operationId}`)
          assert.equal(input.entries[0]?.kind, 'existing')
          assert.equal(input.entries[0]?.links?.[0]?.url, 'https://example.test/video/aaa-1')
          return { playlistId: 99, added: 1, relatedLinksAdded: 1 }
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
    assert.equal(outcome.relatedLinksAdded, 1)
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
          }),
          listVideoSources: async () => ({ items: [{ videoId: 20, sources: [] }] })
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
