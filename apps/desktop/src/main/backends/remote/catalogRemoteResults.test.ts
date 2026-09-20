import assert from 'node:assert/strict'
import { test } from 'node:test'
import { catalogRemoteResult } from './catalogRemoteResults'
import { createUnconfiguredRemoteBackend } from './unconfiguredRemoteBackend'
import { CATALOG_METHODS } from '../../application/catalogMethods'

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
