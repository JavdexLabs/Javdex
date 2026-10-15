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
import { ManageHttpClient } from './manageClient'
import { isStructuredError } from '@shared/protocol/errors'

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
  const unpairedClient = new ManageHttpClient({ baseUrl: origin, appVersion: 'test' })
  const mismatchedClient = new ManageHttpClient({ baseUrl: origin, appVersion: 'test', certificateSha256: '0'.repeat(64), allowSelfSignedCertificate: true })
  const manual = createPinnedFetch(origin, undefined, { allowSelfSignedCertificate: true })
  const bridge = createPlaybackBridge(origin, valid.fetch)
  try {
    await assert.rejects(unpairedClient.post('handshake.get', {}), error => isStructuredError(error) && /证书未受信任.*一次性配对/.test(error.message))
    await assert.rejects(mismatchedClient.post('handshake.get', {}, { bearer: 'never-send' }), error => isStructuredError(error) && /证书已变化.*信任新证书/.test(error.message))
    await assert.rejects(invalid.fetch(origin, { headers: { Authorization: 'Bearer never-send' } }))
    assert.equal(requests, 0)
    let release!: () => void, observed!: () => void
    const seen = new Promise<void>(resolve => { observed = resolve })
    const approval = new Promise<void>(resolve => { release = resolve })
    const waiting = createPinnedFetch(origin, undefined, { verifyCertificate: async (fingerprint, publiclyTrusted) => {
      assert.equal(fingerprint, pin); assert.equal(publiclyTrusted, false); observed(); await approval
    } })
    try {
      const request = waiting.fetch(origin, { headers: { Authorization: 'Bearer withheld-until-consent' } })
      await seen
      assert.equal(requests, 0, 'neither headers nor body are sent while certificate confirmation is pending')
      release()
      assert.equal(await (await request).text(), 'ok')
    } finally { await waiting.close() }
    const refused = createPinnedFetch(origin, undefined, { verifyCertificate: async () => { throw new Error('declined certificate change') } })
    try {
      const before = requests
      await assert.rejects(refused.fetch(origin, { headers: { Authorization: 'Bearer never-send' } }))
      assert.equal(requests, before)
    } finally { await refused.close() }
    assert.equal(await (await valid.fetch(origin)).text(), 'ok')
    assert.equal(await (await manual.fetch(origin)).text(), 'ok')
    await assert.rejects(manual.fetch('https://example.invalid/', { headers: { Authorization: 'Bearer secret' } }), /其他地址/)
    await assert.rejects(manual.fetch(`${origin}/redirect`))
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
  } finally { await bridge.close(); await valid.close(); await invalid.close(); await manual.close(); await unpairedClient.close(); await mismatchedClient.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); fs.rmSync(directory, { recursive: true, force: true }) }
})
