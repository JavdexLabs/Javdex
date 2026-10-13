import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { test } from 'node:test'
import { ServerUpdateClient } from './updateClient'

test('cross-version update transport authenticates the pinned certificate before sending the token', { skip: spawnSync('openssl', ['version']).status !== 0 ? 'OpenSSL is required to generate the isolated TLS test certificate' : false }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-update-tls-'))
  let requests = 0
  const token = 'd'.repeat(64)
  const serverId = randomUUID()
  const catalogId = randomUUID()
  const key = path.join(directory, 'key.pem')
  const cert = path.join(directory, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-nodes', '-days', '1', '-subj', '/CN=test', '-keyout', key, '-out', cert], { stdio: 'ignore' })
  const certificate = new X509Certificate(fs.readFileSync(cert))
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (request, response) => {
    requests++
    assert.equal(request.headers.authorization, `Bearer ${token}`)
    assert.equal(request.headers['x-javdex-app-version'], undefined)
    request.resume()
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ protocolVersion: 1, paired: true, serverId, catalogId, currentVersion: '0.8.0', platform: 'linux/amd64', targetVersion: null, job: null }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const pairing = { protocolVersion: 1 as const, url: `https://127.0.0.1:${address.port}/`, certificateSha256: createHash('sha256').update(certificate.raw).digest('hex'), token, serverId, catalogId }
  try {
    const result = await new ServerUpdateClient(pairing).control('status')
    assert.equal(result.currentVersion, '0.8.0')
    assert.equal(requests, 1)
    await assert.rejects(new ServerUpdateClient({ ...pairing, certificateSha256: 'f'.repeat(64) }).control('status'), /证书/)
    assert.equal(requests, 1)
    await assert.rejects(new ServerUpdateClient({ ...pairing, serverId: randomUUID() }).control('status'), /身份不一致/)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
