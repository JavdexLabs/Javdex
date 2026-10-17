import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { startPlaybackRemoteServer } from './playback-remote-server'
import { smokeConnection } from './server-smoke-connection'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-playback-acceptance-server-startup-'))
const version = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version as string
const media = path.join(directory, 'media'); fs.mkdirSync(media)
const profile = path.join(directory, 'client-profile'); fs.mkdirSync(profile)
const config = path.join(directory, 'server.json')
fs.writeFileSync(config, JSON.stringify({ listenHost: '127.0.0.1', port: 0, accessHosts: ['127.0.0.1'],
  dataDir: path.join(directory, 'data'), imagesDir: path.join(directory, 'data/images'),
  staticRoot: path.resolve('out/server/web'), mediaMounts: { synthetic: media }, web: { username: 'fixture' } }))
let server: Awaited<ReturnType<typeof startPlaybackRemoteServer>> | undefined
let connection: ReturnType<typeof smokeConnection> | undefined
try {
  server = await startPlaybackRemoteServer(directory, path.resolve('out/server/index.js'), config, path.join(directory, 'traffic.json'))
  connection = smokeConnection(server.origin)
  assert.equal((await connection.fetch(server.origin + '/ready')).status, 200)
  assert.equal(connection.certificateSha256, server.certificateSha256)
  assert.equal((await fetch(server.origin.replace('https:', 'http:') + '/manage/v1/handshake.get', { method: 'POST', body: '{}' })).status, 403)
  assert.equal((await connection.fetch(server.origin + '/runtime/v1/info')).status, 404, 'do not pretend this is the managed Linux environment')
  const token = randomBytes(32).toString('hex')
  const paired = await connection.claim(server.oneTimeToken, version, token) as { serverId: string; catalogId: string; certificateSha256: string }
  assert.equal(paired.certificateSha256, server.certificateSha256)
  const child = spawn(process.execPath, ['scripts/run-electron-tests.mjs', 'scripts/playback-remote-runtime-check.test.ts'], {
    cwd: process.cwd(), stdio: 'inherit', env: { ...process.env, JAVDEX_FIXTURE_REMOTE_PROFILE: profile,
      JAVDEX_FIXTURE_REMOTE_PAIRING: JSON.stringify({ ...paired, token }) }
  })
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  assert.equal(result.signal, null); assert.equal(result.code, 0)
  console.log('Actual Node business + production HTTPS pairing/proxy + desktop runtime restart PASS; no native media, Linux manager, GUI or public software acceptance')
} finally {
  await connection?.close()
  await server?.stop()
  fs.rmSync(directory, { recursive: true, force: true })
}
