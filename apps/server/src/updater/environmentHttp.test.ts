import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { serveServerEnvironment } from './environmentHttp'

test('image environment discovery works without business, pairing or version headers', async () => {
  const server = createServer((request, response) => {
    if (!serveServerEnvironment(request, response)) { response.writeHead(503); response.end('business offline') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  try {
    const response = await fetch(`${origin}/runtime/v1/info`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { format: 1, environmentVersion: 1, runtimeId: 'node22-bookworm-v1', platform: process.arch === 'x64' ? 'linux/amd64' : 'linux/arm64' })
    const wrongMethod = await fetch(`${origin}/runtime/v1/info`, { method: 'POST' })
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.get('allow'), 'GET')
    assert.equal((await fetch(`${origin}/manage/v1/hello`)).status, 503)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
