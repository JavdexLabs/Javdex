import assert from 'node:assert/strict'
import { test } from 'node:test'
import { catalogRemoteResult } from './catalogRemoteResults'
import { createUnconfiguredRemoteBackend } from './unconfiguredRemoteBackend'
import { CATALOG_METHODS } from '../../application/catalogMethods'

test('source lookup validates nested entries before matching and keeps nullable source fields', () => {
  const page = { items: [{ videoId: 1, code: 'A-1', sources: [{ source: 'site', externalCode: null, url: null }] }], total: 1, limit: 50, offset: 0 }
  assert.deepEqual(catalogRemoteResult('videos.sources', JSON.parse(JSON.stringify(page))), page)
  for (const invalid of [{}, { ...page, total: '1' }, { ...page, items: [{ videoId: 1, code: 'A-1', sources: [{}] }] }]) {
    assert.throws(() => catalogRemoteResult('videos.sources', invalid), { code: 'INVALID_INPUT' })
  }
})

test('lifecycle previews require complete impact and commit envelopes validate domain results', () => {
  const impact = {
    kind: 'delete-globally', revision: 'revision', videoId: 1,
    sourceLibraryId: null, targetLibraryId: null, resourceIds: [], sourcePaths: [],
    remainingLibraryIds: [], removesCanonicalVideo: true, playlistCount: 0, assetCount: 0,
    libraries: [], resources: [], playlists: [], mediaAssets: [], pendingScrapeCount: 0,
    pendingAgentDraftCount: 0, pendingStagingAssetCount: 0, sourceFilesPreserved: false
  }
  for (const op of ['videos.previewDeleteGlobal', 'videos.previewMoveResource', 'videos.previewRemoveFromLibrary'] as const) {
    assert.deepEqual(catalogRemoteResult(op, impact), impact)
    assert.throws(() => catalogRemoteResult(op, { ...impact, sourceFilesPreserved: undefined }), { code: 'INVALID_INPUT' })
    assert.throws(() => catalogRemoteResult(op, { ...impact, resources: [{ resourceId: 1 }] }), { code: 'INVALID_INPUT' })
  }
  const result = { operationId: 'op', kind: 'delete-globally', videoId: 1, sourceLibraryId: null,
    targetLibraryId: null, resourceIds: [], promotedResourceId: null, canonicalVideoDeleted: true }
  for (const op of ['videos.deleteGlobal', 'videos.moveResource', 'videos.removeFromLibrary'] as const) {
    assert.deepEqual(catalogRemoteResult(op, { receipt: {}, data: result }), result)
    assert.deepEqual(catalogRemoteResult(op, { receipt: {}, ...result }), result)
    assert.throws(() => catalogRemoteResult(op, { ...result, canonicalVideoDeleted: 'true' }), { code: 'INVALID_INPUT' })
  }
  const moved = { ...result, kind: 'move-resource', sourceMembershipRemoved: true }
  assert.deepEqual(catalogRemoteResult('videos.moveResource', { receipt: {}, data: moved }), moved)
  assert.throws(() => catalogRemoteResult('videos.moveResource', {
    receipt: {}, data: { ...moved, sourceMembershipRemoved: 'true' }
  }), { code: 'INVALID_INPUT' })
})

test('remote adapters normalize primitive and enveloped boolean results, including false', () => {
  assert.equal(catalogRemoteResult('videos.edit', { ok: false }), false)
  assert.equal(catalogRemoteResult('videos.edit', false), false)
  assert.equal(catalogRemoteResult('videos.setRating', { ok: true, videoId: 1 }), true)
  assert.equal(catalogRemoteResult('videos.setPoster', { posterPath: null, versions: { V: { generation: 1, revision: 2 } } }), true)
  assert.equal(catalogRemoteResult('actresses.setPoster', { versions: { A: { generation: 1, revision: 2 } } }), true)
  assert.equal(catalogRemoteResult('playlists.update', { playlistId: 1, versions: { P: { generation: 1, revision: 2 } } }), true)
  assert.throws(() => catalogRemoteResult('videos.edit', { unrelated: true }), { code: 'INVALID_INPUT' })
})

test('remote create operations return the same ID primitives as local operations', () => {
  assert.equal(catalogRemoteResult('organizations.create', { id: 7 }), 7)
  assert.equal(catalogRemoteResult('directors.create', 9), 9)
  assert.equal(catalogRemoteResult('series.create', { id: 11 }), 11)
  assert.equal(catalogRemoteResult('playlists.create', { playlistId: 13 }), 13)
  assert.throws(() => catalogRemoteResult('playlists.create', { id: 13 }), { code: 'INVALID_INPUT' })
})

test('batch asset and domain object results retain their payloads', () => {
  const response = { assetIds: [3, 4], versions: { V: { generation: 1, revision: 2 } } }
  assert.equal(catalogRemoteResult('videos.importSamples', response), response)
  const result = { ok: true }
  assert.equal(catalogRemoteResult('pendingVideoScrapes.discard', result), result)
})

test('commit receipt envelopes unwrap data without dropping domain metadata', () => {
  const receipt = { operationId: 'operation', status: 'applied' }
  assert.equal(catalogRemoteResult('videos.edit', { receipt, data: false }), false)
  assert.equal(catalogRemoteResult('playlists.create', { receipt, data: { playlistId: 3 } }), 3)
  const data = { status: 'applied', target: { kind: 'video', id: 3 }, warnings: ['kept'], versions: { V: { generation: 1, revision: 2 } } }
  assert.equal(catalogRemoteResult('agentMetadata.apply', { receipt, data }), data)
  const flattened = { receipt, ...data }
  assert.equal(catalogRemoteResult('agentMetadata.apply', flattened), flattened)
  const task = { receipt, taskId: 'task' }
  assert.equal(catalogRemoteResult('scans.run', task), task)
})

test('unconfigured backend implements every method and rejects consistently', async () => {
  const backend = createUnconfiguredRemoteBackend()
  for (const slice of Object.keys(CATALOG_METHODS) as Array<keyof typeof CATALOG_METHODS>) {
    const methods = backend[slice]
    assert.deepEqual(Object.keys(methods).sort(), Object.keys(CATALOG_METHODS[slice]).sort())
    for (const method of Object.values(methods) as Array<() => Promise<never>>) {
      await assert.rejects(method(), { code: 'CONNECTION_UNAVAILABLE' })
    }
  }
})

test('validates actress edit versions before adapting the result to the legacy boolean', () => {
  assert.equal(catalogRemoteResult('actresses.edit', {
    ok: false, versions: { A: { generation: 1, revision: 2 } }
  }), false)
  for (const response of [true, { ok: true }, { ok: true, versions: { A: { generation: 1, revision: '2' } } }]) {
    assert.throws(() => catalogRemoteResult('actresses.edit', response), { code: 'INVALID_INPUT' })
  }
})

test('validates playlist pagination fields and retains declared aggregate versions', () => {
  const page = { videos: [], total: 3, filteredTotal: 1, limit: 1, offset: 2 }
  assert.deepEqual(catalogRemoteResult('playlists.videoPage', page), page)
  for (const response of [
    { videos: [], total: 3, limit: 1, offset: 2 },
    { ...page, total: '3' },
    { ...page, videos: [{}] }
  ]) {
    assert.throws(() => catalogRemoteResult('playlists.videoPage', response), { code: 'INVALID_INPUT' })
  }
  const detail = { id: 1, name: 'List', description: null, cover_path: null,
    created_at: '2026-09-20', updated_at: null, generation: 1, revision: 7, videos: [], links: [] }
  assert.deepEqual(catalogRemoteResult('playlists.get', detail), detail)
})
