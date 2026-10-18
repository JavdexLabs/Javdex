import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { it } from 'node:test'
import { probeRemoteConnection } from '../../ipc/desktopSessionHandlers'
import { createThisComputerSettingsStore, thisComputerSettingsPath } from '../../desktop/thisComputerSettingsStore'
import { createRemoteCatalogBackend } from './remoteCatalogBackend'

it('manual self-signed HTTPS works for probes, saved connections, images and playback without granting device authorization', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-manual-https-'))
  const key = path.join(root, 'key.pem'), cert = path.join(root, 'cert.pem')
  // Matches the deployment certificate: self-signed, without an IP subjectAltName.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=JavdexUpdater', '-keyout', key, '-out', cert], { stdio: 'ignore' })
  let requests = 0, playbackGrants = 0
  const revokedPlaybacks = new Set<number>()
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, async (request, response) => {
    requests++
    for await (const _ of request) { /* Drain the request before responding. */ }
    const route = request.url ?? ''
    if (route.startsWith('/play/')) {
      assert.equal(request.headers.authorization, undefined)
      if (request.method !== 'HEAD' || request.headers.range) assert.equal(request.headers.range, 'bytes=1-3')
      const grantId = Number(/test-(\d+)/.exec(route)?.[1])
      if (revokedPlaybacks.has(grantId)) { response.writeHead(404); response.end(); return }
      response.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': '3', 'Content-Range': 'bytes 1-3/5' })
      response.end(request.method === 'HEAD' ? undefined : 'bcd')
      return
    }
    response.setHeader('Content-Type', 'application/json')
    if (route.endsWith('/handshake.get')) {
      assert.equal(request.headers.authorization, undefined)
      response.end(JSON.stringify({ appVersion: '0.9.0-beta.4', schemaVersion: 21,
        identity: { serverId: 'server', catalogId: 'catalog' }, writerEpoch: 1, ready: 'ready' }))
      return
    }
    assert.equal(request.headers.authorization, 'Bearer manual-secret')
    if (route.endsWith('/catalog.storageInfo')) response.end(JSON.stringify({ imagesDir: '/data/images' }))
    else if (route.includes('/assets/')) { response.setHeader('Content-Type', 'image/png'); response.end('image fixture') }
    else if (route.endsWith('/play.grant')) {
      playbackGrants++
      response.end(JSON.stringify({ grantId: 'grant', resourceId: 1,
        expiresAt: new Date(Date.now() + (playbackGrants === 1 ? 10_000 : 12 * 60 * 60 * 1000)).toISOString(),
        playbackHandle: `/play/v1/test-${playbackGrants}.mp4?t=scoped`, methods: ['HEAD', 'GET'], range: true }))
    }
    else { response.statusCode = 404; response.end('{}') }
  })
  const backends: ReturnType<typeof createRemoteCatalogBackend>[] = []
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const baseUrl = `https://127.0.0.1:${address.port}`
    assert.equal((await probeRemoteConnection(baseUrl, '0.9.0-beta.4')).status, 'reachable')
    assert.equal((await probeRemoteConnection(baseUrl, 'different-version')).status, 'versionMismatch')
    const beforeMismatch = requests
    const mismatch = await probeRemoteConnection(baseUrl, '0.9.0-beta.4', '0'.repeat(64))
    assert.equal(mismatch.status, 'unavailable')
    assert.match(mismatch.message, /证书已变化/)
    assert.equal(requests, beforeMismatch, 'paired certificate mismatches still block the HTTP request')

    const settings = createThisComputerSettingsStore(thisComputerSettingsPath(root))
    await settings.write({ mode: 'remote', remoteBaseUrl: baseUrl })
    const stored = await settings.read()
    let secret: string | null = null
    const createBackend = () => {
      const backend = createRemoteCatalogBackend({ baseUrl: stored.remoteBaseUrl!, appVersion: '0.9.0-beta.4', credentials: {
        isAvailable: async () => true, readWriterSecret: async () => secret,
        writeWriterSecret: async () => {}, deleteWriterSecret: async () => {}
      } })
      backends.push(backend)
      return backend
    }
    const unauthorized = createBackend()
    assert.equal((await unauthorized.reconnect()).state, 'recoveryRequired', 'TLS acceptance does not create writer credentials')
    await unauthorized.dispose()
    secret = 'manual-secret'
    // Recreate the backend from saved settings as a process restart does.
    const backend = createBackend()
    assert.equal((await backend.reconnect()).state, 'available')
    const image = await backend.assets.readImage({ relPath: 'cover.png' })
    assert.equal(image.body.toString(), 'image fixture')
    const grant = await backend.assets.grantPlayback({ libraryId: 1, videoId: 1, resourceId: 1, locatorRevision: 'fixture' }, { sessionBound: true })
    assert.equal(new URL(grant.playbackHandle).protocol, 'http:')
    assert.equal(new URL(grant.playbackHandle).hostname, '127.0.0.1')
    const media = await fetch(grant.playbackHandle, { headers: { Range: 'bytes=1-3' } })
    assert.equal(media.status, 206)
    assert.equal(await media.text(), 'bcd')
    const head = await fetch(grant.playbackHandle, { method: 'HEAD', headers: { Range: 'bytes=1-3' } })
    assert.equal(head.status, 206)
    assert.equal(head.headers.get('content-range'), 'bytes 1-3/5')
    assert.equal(playbackGrants, 2, 'a near-expiry session route renews its authenticated upstream once')
    const external = await backend.assets.grantPlayback({ libraryId: 1, videoId: 1, resourceId: 1, locatorRevision: 'fixture' })
    const repeated = await backend.assets.grantPlayback({ libraryId: 1, videoId: 1, resourceId: 1, locatorRevision: 'fixture' })
    assert.equal(repeated.playbackHandle, external.playbackHandle)
    assert.equal(playbackGrants, 3, 'reopening an external resource must reuse the existing server grant')
    revokedPlaybacks.add(3)
    const recovered = await backend.assets.grantPlayback({ libraryId: 1, videoId: 1, resourceId: 1, locatorRevision: 'fixture' })
    assert.notEqual(recovered.playbackHandle, external.playbackHandle)
    assert.equal(playbackGrants, 4, 'an invalid cached grant is replaced before opening the external player')
    assert.equal((await fetch(external.playbackHandle)).status, 403)
    backend.releasePlayback!(grant.playbackHandle)
    assert.equal((await fetch(grant.playbackHandle)).status, 403)
    assert.equal((await fetch(recovered.playbackHandle, { method: 'HEAD', headers: { Range: 'bytes=1-3' } })).status, 206)
  } finally {
    await Promise.all(backends.map(backend => backend.dispose()))
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
