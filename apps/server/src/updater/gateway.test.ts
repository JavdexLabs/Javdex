import assert from 'node:assert/strict'
import http, { type IncomingMessage } from 'node:http'
import { test } from 'node:test'
import { gatewayRequestAllowed, cleanProxyHeaders, proxyBusiness } from './gateway'
import { gatewayPeer } from '@http/gatewayPeer'

test('gateway requires configured authority and origin; forwarding headers do not confer trust', () => {
  const origin = 'https://library.local:8096'
  const request = { url: '/manage/v1/handshake.get', headers: { host: 'library.local:8096', origin }, socket: { remoteAddress: '192.168.1.5' } } as IncomingMessage
  assert.equal(gatewayRequestAllowed(request, origin), true)
  assert.equal(gatewayRequestAllowed({ ...request, headers: { ...request.headers, host: 'evil.local' } } as IncomingMessage, origin), false)
  assert.equal(gatewayRequestAllowed({ ...request, headers: { ...request.headers, origin: 'https://evil.local' } } as IncomingMessage, origin), false)
  assert.equal(gatewayRequestAllowed({ ...request, url: '//evil.local/' } as IncomingMessage, origin), false)
  const config = { origin, token: 'd'.repeat(64) }
  assert.equal(gatewayPeer(request, config), null)
  const internal = { headers: { 'x-javdex-gateway': config.token, 'x-javdex-peer': '192.168.1.5' }, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage
  assert.equal(gatewayPeer(internal, config), '192.168.1.5')
  assert.equal(gatewayPeer({ ...internal, headers: { ...internal.headers, 'x-javdex-gateway': 'x'.repeat(64) } } as unknown as IncomingMessage, config), null)
  assert.deepEqual(cleanProxyHeaders({ connection: 'X-Remove', 'x-remove': 'secret', authorization: 'Bearer writer', 'x-javdex-peer': '127.0.0.1', forwarded: 'for=127.0.0.1', 'x-forwarded-host': 'evil' }), { authorization: 'Bearer writer' })
})
test('fixed upstream streams Range/HEAD, marks cookies Secure, and blocks loopback-only recovery', async () => {
  let requests = 0
  const upstream = http.createServer((request, response) => {
    requests++
    assert.equal(request.headers['x-javdex-gateway'], 'd'.repeat(64))
    assert.equal(request.headers['x-javdex-peer'], '127.0.0.1')
    assert.equal(request.headers['x-forwarded-for'], undefined)
    response.writeHead(206, { 'Content-Range': 'bytes 1-3/5', 'Content-Length': '3', 'Set-Cookie': 'session=x; HttpOnly; SameSite=Strict' })
    response.end(request.method === 'HEAD' ? undefined : 'bcd')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address(); assert.ok(address && typeof address !== 'string')
  const gateway = http.createServer((request, response) => proxyBusiness(request, response, `http://127.0.0.1:${address.port}`, `127.0.0.1:${address.port}`, { origin: 'https://library.local', token: 'd'.repeat(64) }))
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve))
  const entry = gateway.address(); assert.ok(entry && typeof entry !== 'string')
  const url = `http://127.0.0.1:${entry.port}`
  try {
    const response = await fetch(`${url}/play/v1/file`, { headers: { Range: 'bytes=1-3', 'X-Forwarded-For': '127.0.0.1', 'X-Javdex-Peer': '8.8.8.8' } })
    assert.equal(await response.text(), 'bcd'); assert.equal(response.headers.get('content-range'), 'bytes 1-3/5')
    assert.match(response.headers.get('set-cookie')!, /Secure/)
    assert.equal((await fetch(`${url}/play/v1/file`, { method: 'HEAD' })).status, 206)
    assert.equal((await fetch(`${url}/manage/v1/writer.recoverIssue`, { method: 'POST' })).status, 403)
    assert.equal((await fetch(`${url}/manage/v1/writer.%72ecoverIssue`, { method: 'POST' })).status, 403)
    assert.equal(requests, 2)
  } finally { gateway.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise<void>(r => gateway.close(() => r())), new Promise<void>(r => upstream.close(() => r()))]) }
})
