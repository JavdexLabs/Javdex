import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRemoteCatalogBackend } from './remoteCatalogBackend'
import { ManageHttpClient } from '@http/manageClient'

test('HTTP wire envelopes normalize to catalog values and local paths never cross the wire', async () => {
  const receipt = { operationId: 'operation', status: 'applied' }
  const versions = { V: { generation: 1, revision: 2 } }
  const metadata = { status: 'applied', target: { kind: 'video', id: 1 }, warnings: ['retained'], versions }
  const replies: Record<string, unknown> = {
    'handshake.get': {
      protocolVersion: 1, appVersion: '0.7.0', schemaVersion: 19,
      identity: { serverId: 'server', catalogId: 'catalog' }, writerEpoch: 1, ready: 'ready'
    },
    'videos.edit': { receipt, ok: false, versions },
    'videos.setPoster': { receipt, posterPath: null, versions },
    'directors.create': { receipt, id: 7 },
    'playlists.create': { receipt, playlistId: 9, versions: { P: versions.V } },
    'playlists.update': { receipt, playlistId: 9, versions: { P: versions.V } },
    'agentMetadata.apply': { receipt, data: metadata },
    'targetLists.create': { receipt, targetListId: 'targets', count: 3 }
  }
  const requests: string[] = []
  const server = createServer((req, res) => {
    const operation = (req.url ?? '').split('/').at(-1) ?? ''
    requests.push(operation)
    req.resume()
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(replies[operation] ?? {}))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const backend = createRemoteCatalogBackend({
    baseUrl, appVersion: '0.7.0',
    credentials: {
      isAvailable: async () => true,
      readWriterSecret: async () => 'secret',
      writeWriterSecret: async () => {},
      deleteWriterSecret: async () => {}
    }
  })
  try {
    const raw = new ManageHttpClient({ baseUrl, appVersion: '0.7.0' })
    assert.deepEqual(await raw.post('videos.edit', {}), replies['videos.edit'])
    const context = { operationId: 'operation', expectedVersions: {} }
    assert.equal(await backend.videos.edit({ videoId: 1, fields: { title: 'title' } }, context), false)
    assert.equal(await backend.videos.setPoster({ videoId: 1, image: { kind: 'clear' } }, context), true)
    assert.equal(await backend.classifications.createDirector({ mainName: 'Director' }, context), 7)
    assert.equal(await backend.playlists.create({ name: 'List' }, context), 9)
    assert.equal(await backend.playlists.update({ playlistId: 9, name: 'Renamed' }, context), true)
    assert.deepEqual(await backend.agentMetadata.apply({ draftId: 'draft', reviewToken: 'review' }, context), metadata)
    const before = requests.length
    await assert.rejects(async () => backend.videos.edit({ videoId: 1, fields: { coverSourcePath: '/private/image.jpg' } }, context), { code: 'INVALID_INPUT' })
    await assert.rejects(async () => backend.videos.setPoster({ videoId: 1, image: { kind: 'clear' }, posterPath: '/private/image.jpg' }, context), { code: 'INVALID_INPUT' })
    await assert.rejects(async () => backend.videos.importSamples({ videoId: 1, source: 'file', sourcePath: '/private/image.jpg' }, context), { code: 'INVALID_INPUT' })
    await assert.rejects(async () => backend.libraries.addRoot({ libraryId: 1, expectedRevision: 2, root: { path: '/private/media' } }, context), { code: 'INVALID_INPUT' })
    assert.equal(requests.length, before, 'invalid desktop inputs must fail before an HTTP request')
  } finally {
    await backend.dispose()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('preserves playlist query fields and maps library revisions without replacing explicit stale versions', async () => {
  const requests: Array<{ operation: string; body: { input: unknown; expectedVersions: unknown } }> = []
  const server = createServer(async (req, res) => {
    const operation = (req.url ?? '').split('/').at(-1) ?? ''
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ operation, body: JSON.parse(body) })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(operation === 'handshake.get' ? {
      protocolVersion: 1, appVersion: '0.7.1', schemaVersion: 19,
      identity: { serverId: 'server', catalogId: 'catalog' }, writerEpoch: 1, ready: 'ready'
    } : {}))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const backend = createRemoteCatalogBackend({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, appVersion: '0.7.1',
    credentials: { isAvailable: async () => true, readWriterSecret: async () => 'secret',
      writeWriterSecret: async () => {}, deleteWriterSecret: async () => {} }
  })
  try {
    const context = { operationId: 'operation', expectedVersions: {} }
    for (const operation of ['get', 'metadata', 'getPage', 'videoPage'] as const) {
      const query = { playlistId: 9, sortBy: 'release_date' as const, sortDir: 'asc' as const }
      await backend.playlists[operation](query)
      assert.deepEqual(requests.at(-1)?.body.input, { ...query, ...(['getPage', 'videoPage'].includes(operation) ? { limit: 50, offset: 0 } : {}) })
    }
    await backend.playlists.listPage({ search: '', videoId: 3, locale: 'en', limit: 60, offset: 0 })
    assert.deepEqual(requests.at(-1)?.body.input, { search: '', videoId: 3, locale: 'en', limit: 60, offset: 0 })
    await backend.libraries.updateConfig({ libraryId: 1, expectedRevision: 3, patch: { autoImportLocalNfo: true } }, context)
    assert.deepEqual(requests.at(-1)?.body.input, { libraryId: 1, patch: { autoImportLocalNfo: true } })
    assert.deepEqual(requests.at(-1)?.body.expectedVersions, { C: { generation: 1, revision: 3 } })
    await backend.libraries.updateConfig({ libraryId: 1, expectedRevision: 3, patch: { autoImportLocalNfo: false } },
      { ...context, expectedVersions: { C: { generation: 1, revision: 2 } } })
    assert.deepEqual(requests.at(-1)?.body.expectedVersions, { C: { generation: 1, revision: 2 } })
    await backend.libraries.update({ libraryId: 1, expectedRevision: 4, patch: { name: 'Renamed' } }, context)
    assert.deepEqual(requests.at(-1)?.body.input, { libraryId: 1, name: 'Renamed' })
    assert.deepEqual(requests.at(-1)?.body.expectedVersions, { L: { generation: 1, revision: 4 } })
    await backend.libraries.addRoot({ libraryId: 1, expectedRevision: 4, root: { mountSelectionId: 'media' } } as Parameters<typeof backend.libraries.addRoot>[0], context)
    assert.deepEqual(requests.at(-1)?.body.input, { libraryId: 1, root: { mountSelectionId: 'media' } })
    assert.deepEqual(requests.at(-1)?.body.expectedVersions, { L: { generation: 1, revision: 4 }, G: { generation: 1, revision: 1 } })
  } finally {
    await backend.dispose()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
