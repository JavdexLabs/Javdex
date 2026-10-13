import assert from 'node:assert/strict'
import { createServer, type RequestListener } from 'node:http'
import { test } from 'node:test'
import { requestBusiness } from './businessHttp'

async function withServer(handler: RequestListener, run: (url: URL) => Promise<void>): Promise<void> {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try { await run(new URL(`http://127.0.0.1:${address.port}/probe`)) } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

test('internal business requests send the configured Host and exact JSON POST bytes', async () => {
  const body = JSON.stringify({ input: { label: '验证' } })
  await withServer((incoming, response) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => response.end(JSON.stringify({ host: incoming.headers.host, method: incoming.method,
      type: incoming.headers['content-type'], bytes: incoming.headers['content-length'], body: Buffer.concat(chunks).toString('utf8') })))
  }, async url => {
    const result = await requestBusiness(url, 'library.local:8096', { body })
    assert.equal(result.ok, true)
    assert.deepEqual(JSON.parse(result.body), { host: 'library.local:8096', method: 'POST', type: 'application/json', bytes: String(Buffer.byteLength(body)), body })
  })
})

test('internal probes retain HTTP failures and never follow redirects', async () => {
  let calls = 0
  await withServer((_incoming, response) => { calls++; response.writeHead(302, { Location: '/other' }); response.end('not ready') }, async url => {
    assert.deepEqual(await requestBusiness(url, 'library.local:8096'), { status: 302, ok: false, body: 'not ready' })
    assert.equal(calls, 1)
  })
})

test('internal probes bound response size and abort stalled requests', async () => {
  await withServer((_incoming, response) => response.end(Buffer.alloc(64 * 1024 + 1)), async url => {
    await assert.rejects(requestBusiness(url, 'library.local:8096'), /响应超限/)
  })
  await withServer(() => {}, async url => {
    await assert.rejects(requestBusiness(url, 'library.local:8096', { timeoutMs: 25 }), { name: 'AbortError' })
  })
})
