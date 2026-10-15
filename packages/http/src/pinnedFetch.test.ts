import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { test } from 'node:test'
import { createPinnedFetch } from './pinnedFetch'
import { createPlaybackBridge } from './playbackBridge'

test('pinned transport withholds secrets on mismatch; scoped playback supports Range/HEAD and revocation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pin-'))
  const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test', '-keyout', key, '-out', cert], { stdio: 'ignore' })
  let requests = 0
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (request, response) => {
    requests++
    if (request.url === '/redirect') { response.writeHead(302, { Location: 'https://example.invalid/' }); response.end(); return }
    if (request.url?.startsWith('/play/')) {
      assert.equal(request.headers.authorization, undefined)
      response.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': '3', 'Content-Range': 'bytes 1-3/5' }); response.end(request.method === 'HEAD' ? undefined : 'bcd')
    } else { response.end('ok') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const origin = `https://127.0.0.1:${address.port}`
  const pin = createHash('sha256').update(new X509Certificate(fs.readFileSync(cert)).raw).digest('hex')
  const valid = createPinnedFetch(origin, pin), invalid = createPinnedFetch(origin, '0'.repeat(64))
  const bridge = createPlaybackBridge(origin, valid.fetch)
  try {
    await assert.rejects(invalid.fetch(origin, { headers: { Authorization: 'Bearer never-send' } }))
    assert.equal(requests, 0)
    assert.equal(await (await valid.fetch(origin)).text(), 'ok')
    await assert.rejects(valid.fetch('https://example.invalid/', { headers: { Authorization: 'Bearer secret' } }), /其他地址/)
    await assert.rejects(valid.fetch(`${origin}/redirect`))
    const handle = await bridge.grant(`${origin}/play/v1/test?t=scoped`, new Date(Date.now() + 60000).toISOString())
    const media = await fetch(handle, { headers: { Range: 'bytes=1-3' } })
    assert.equal(media.status, 206); assert.equal(await media.text(), 'bcd')
    assert.equal((await fetch(handle, { method: 'HEAD' })).headers.get('content-range'), 'bytes 1-3/5')
    assert.equal((await fetch(handle, { headers: { Origin: 'https://evil.invalid' } })).status, 403)
    await assert.rejects(bridge.grant(`${origin}/manage/v1/test`, new Date(Date.now() + 60000).toISOString()), /无效/)
    bridge.clear()
    assert.equal((await fetch(handle)).status, 403)
  } finally { await bridge.close(); await valid.close(); await invalid.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); fs.rmSync(directory, { recursive: true, force: true }) }
})
