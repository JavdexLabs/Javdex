import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, createConnection, type Socket } from 'node:net'
import { WebServer } from '../packages/http/src/server'
import { ManageHttpClient } from '../packages/http/src/manageClient'
import { postLegacySmoke } from './server-updater-smoke-legacy'

test('legacy smoke preserves internal authority and bearer across a real loopback port mapping', async () => {
  const calls: unknown[] = []
  const web = new WebServer({ username: 'fixture', passwordHash: 'unused', staticRoot: '/unused', catalog: {} as never,
    listenHost: '127.0.0.1', accessHosts: ['127.0.0.1'], manage: { appVersion: '0.8.0', dispatch: context => {
      const result = { operation: context.operation, body: context.body, host: context.host, bearer: context.bearerSecret }
      calls.push(result); return result
    } } })
  const port = await web.start(0)
  const sockets = new Set<Socket>()
  const proxy = createServer(socket => {
    const upstream = createConnection({ host: '127.0.0.1', port })
    for (const item of [socket, upstream]) { sockets.add(item); item.on('close', () => sockets.delete(item)); item.on('error', () => {}) }
    socket.pipe(upstream).pipe(socket)
  })
  let original: ManageHttpClient | undefined
  try {
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const mapped = proxy.address(); assert.ok(mapped && typeof mapped !== 'string')
    const baseUrl = `http://127.0.0.1:${mapped.port}`, authority = `127.0.0.1:${port}`
    original = new ManageHttpClient({ baseUrl, appVersion: '0.8.0' })
    await assert.rejects(original.post('handshake.get', { input: {} }), { code: 'AUTH_REQUIRED' })
    assert.equal(calls.length, 0, 'the original Host guard rejects the mapped external authority')
    for (const operation of ['handshake.get', 'writer.claim', 'writer.status'] as const) {
      const body = { input: { fixture: operation } }, bearer = operation === 'writer.status' ? 'isolated-legacy-secret' : undefined
      const result = await postLegacySmoke({ baseUrl, authority, operation, body, bearer })
      assert.deepEqual(result, { operation, body, host: authority, bearer: bearer ?? null })
    }
    assert.equal(calls.length, 3)
    await assert.rejects(postLegacySmoke({ baseUrl, authority: `127.0.0.1:${mapped.port}`, operation: 'handshake.get', body: { input: {} } }))
    assert.equal(calls.length, 3, 'wrong authority still cannot reach management')
  } finally {
    await original?.close()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => proxy.close(() => resolve()))
    await web.stop()
  }
})
