// Isolated development composition: the real Node business host, pairing store
// and streaming HTTPS proxy. Not the Linux manager, environment or upgrade CI.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, createHash, X509Certificate } from 'node:crypto'
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createDualProtocolServer } from '../apps/server/src/updater/dualProtocolServer'
import { ConnectionPairing } from '../apps/server/src/updater/connectionPairing'
import { gatewayRequestAllowed, gatewayRouteAllowed, proxyBusiness } from '../apps/server/src/updater/gateway'
import { requestBusiness } from '../apps/server/src/updater/businessHttp'
import { readLimitedJson } from '../apps/server/src/updater/updateManager'
import { connectionClaimSchema } from '../packages/contracts/src/serverUpdateTypes'
import { listenFetchServer } from './test-http'
import { testTls } from './test-tls'

export async function startPlaybackRemoteServer(directory: string, serverEntry: string, configFile: string, statsFile: string) {
  assert.equal(process.versions.electron, undefined, 'the business host must run on Node, not Electron')
  assert.ok(path.basename(directory).startsWith('javdex-playback-acceptance-server-'))
  for (const file of [configFile, statsFile]) assert.equal(path.dirname(file), directory)
  const version = JSON.parse(fs.readFileSync(path.join(path.dirname(serverEntry), 'package.json'), 'utf8')).version as string
  assert.equal(version, JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version, 'build the server from the current source version')
  const state = path.join(directory, 'gateway-fixture'); fs.mkdirSync(state)
  const pairing = new ConnectionPairing(state)
  const tls = testTls() // An ephemeral test certificate, never a deployment or release signing key.
  const certificateSha256 = createHash('sha256').update(new X509Certificate(tls.cert).raw).digest('hex')
  const gatewayConfig = { origin: '', token: randomBytes(32).toString('hex') }
  let upstream = '', authority = '', output = '', stopped = false
  let business: ChildProcessWithoutNullStreams | undefined
  let businessFailure: Error | undefined
  let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined
  const hello = async () => {
    const response = await requestBusiness(new URL('/manage/v1/handshake.get', upstream), authority, { body: JSON.stringify({ input: {} }) })
    assert.equal(response.ok, true, 'isolated business handshake failed')
    return JSON.parse(response.body)
  }
  const gateway = createDualProtocolServer(tls, (request, response) => {
    void (async () => {
      const reply = (status: number, value: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify(value))
      }
      if (!gatewayRequestAllowed(request, gatewayConfig.origin) || !gatewayRouteAllowed(request)) {
        reply(403, { error: 'Invalid isolated gateway origin or HTTPS route' }); return
      }
      if (!upstream) { reply(503, { error: 'Isolated business is starting' }); return }
      const pathname = new URL(request.url ?? '/', gatewayConfig.origin).pathname
      if (pathname === '/connect/v1/claim' && request.method === 'POST') {
        if (request.headers.origin) { reply(403, { error: 'Browser claims are not allowed' }); return }
        try {
          const input = connectionClaimSchema.parse(await readLimitedJson(request, 4096))
          assert.equal(input.appVersion, version, 'desktop/server versions must match')
          const receipt = await pairing.claim(input, async (issued, candidate) => {
            const { identity } = await hello()
            assert.equal(identity.serverId, issued.serverId); assert.equal(identity.catalogId, issued.catalogId)
            const claimed = await requestBusiness(new URL('/manage/v1/writer.claim', upstream), authority, {
              appVersion: version, body: JSON.stringify({ ...identity, input: { kind: issued.kind, oneTimeToken: issued.oneTimeToken, candidate } })
            })
            assert.equal(claimed.ok, true, 'real business writer claim failed')
            const result = JSON.parse(claimed.body)
            assert.equal(result.status, 'consumed'); assert.equal(result.bound, true)
            return { protocolVersion: 1, url: gatewayConfig.origin, certificateSha256, ...identity }
          })
          reply(200, receipt)
        } catch { reply(409, { error: 'Isolated unified pairing failed' }) }
        return
      }
      if (pathname.startsWith('/connect/') || pathname.startsWith('/update/') || pathname.startsWith('/runtime/')) {
        reply(404, { error: 'This development host does not implement the managed Linux environment or upgrades' }); return
      }
      proxyBusiness(request, response, upstream, authority, gatewayConfig)
    })().catch(() => {
      if (response.headersSent) response.destroy()
      else { response.writeHead(500); response.end() }
    })
  })
  const stop = async () => {
    if (stopped) return
    stopped = true
    const closed = new Promise<void>(resolve => gateway.close(() => resolve()))
    gateway.closeAllConnections(); await closed
    if (!business || !exited) return
    if (business.exitCode == null && business.signalCode == null) business.kill('SIGTERM')
    const timer = setTimeout(() => business?.kill('SIGKILL'), 10000)
    let result
    try { result = await exited } finally { clearTimeout(timer) }
    assert.equal(result.signal, null, 'isolated Node host must shut down without forced termination')
    assert.equal(result.code, 0, 'isolated Node host must exit cleanly')
  }
  try {
    gatewayConfig.origin = `https://127.0.0.1:${await listenFetchServer(gateway)}`
    const env: NodeJS.ProcessEnv = { ...process.env, JAVDEX_PUBLIC_URL: gatewayConfig.origin, JAVDEX_GATEWAY_TOKEN: gatewayConfig.token,
      JAVDEX_WEB_PASSWORD: randomBytes(32).toString('hex'), JAVDEX_PLAYBACK_SERVER_REPORT: statsFile }
    for (const key of Object.keys(env)) if (key.startsWith('JAVDEX_TEST_') || ['ELECTRON_RUN_AS_NODE', 'JAVDEX_BOOTSTRAP_TOKEN'].includes(key)) delete env[key]
    business = spawn(process.execPath, ['--import', pathToFileURL(path.resolve('scripts/playback-server-observation.mjs')).href,
      serverEntry, 'start', '--config', configFile], { cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'] })
    business.on('error', error => { businessFailure = error })
    const collect = (bytes: Buffer) => { output = (output + bytes.toString()).slice(-1024 * 1024) }
    business.stdout.on('data', collect); business.stderr.on('data', collect)
    exited = new Promise(resolve => {
      business!.once('exit', (code, signal) => resolve({ code, signal }))
      business!.once('error', () => resolve({ code: 1, signal: null }))
    })
    const deadline = Date.now() + 20000
    for (;;) {
      if (businessFailure) throw businessFailure
      assert.ok(business.exitCode == null && business.signalCode == null, `Node host exited before listening: ${output}`)
      const port = /listening on 127\.0\.0\.1:(\d+)/.exec(output)?.[1]
      if (port) {
        upstream = `http://127.0.0.1:${port}`; authority = new URL(upstream).host
        break
      }
      assert.ok(Date.now() < deadline, `Node host startup timed out: ${output}`)
      await delay(100)
    }
    const issued = JSON.parse(execFileSync(process.execPath, [serverEntry, 'token', '--config', configFile], {
      cwd: process.cwd(), env, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe']
    }))
    const grant = pairing.issue(issued)
    return { origin: gatewayConfig.origin, oneTimeToken: grant.code, certificateSha256, stop }
  } catch (error) { await stop().catch(() => {}); throw error }
}
