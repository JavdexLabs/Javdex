import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { queryServerEnvironment } from './serverEnvironmentClient'
import { SERVER_ENVIRONMENT_VERSION } from '@shared/serverEnvironment'
import { listenFetchServer, startFetchServer } from '../../../scripts/test-http'

const environment = { format: 1, environmentVersion: SERVER_ENVIRONMENT_VERSION, runtimeId: 'node22-bookworm-v1', platform: 'linux/amd64' }

async function listen(server: http.Server, protocol = 'http'): Promise<string> {
  return `${protocol}://127.0.0.1:${await listenFetchServer(server)}`
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}

async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('test operation exceeded its deadline')), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

test('HTTP fixtures stay Fetch-compatible with a low OS dynamic range and an occupied port', async t => {
  const occupied = http.createServer()
  const occupiedPort = await listenFetchServer(occupied)
  const server = http.createServer((_request, response) => response.end('fixture reached'))
  const originalListen = server.listen.bind(server)
  const ports: number[] = []
  // Exercise a real bind collision without racing a released port or changing the host's dynamic range.
  t.mock.method(server, 'listen', (port: number, host: string) => {
    ports.push(port)
    assert.ok(port >= 49152 && port <= 65535, 'do not delegate to a possibly Fetch-blocked OS ephemeral port')
    return originalListen(ports.length === 1 ? occupiedPort : port, host)
  })
  try {
    const origin = await listen(server)
    assert.ok(ports.length >= 2, 'retry a real EADDRINUSE bind failure')
    assert.equal(await (await fetch(origin)).text(), 'fixture reached')
  } finally { await close(server); await close(occupied) }
})

test('wrapped HTTP fixture retries are bounded and do not hide non-bind failures', async () => {
  let attempts = 0
  const ports: number[] = []
  const port = await startFetchServer(async selected => {
    ports.push(selected)
    const code = ['EADDRINUSE', 'EACCES'][attempts++]
    if (code) throw Object.assign(new Error(code), { code })
    return selected
  })
  assert.equal(attempts, 3)
  assert.equal(port, ports.at(-1))
  assert.ok(ports.every(value => Number.isInteger(value) && value >= 49152 && value <= 65535))
  const fatal = Object.assign(new Error('fixture setup failed'), { code: 'EINVAL' })
  attempts = 0
  await assert.rejects(startFetchServer(async () => { attempts++; throw fatal }), error => error === fatal)
  assert.equal(attempts, 1)
  attempts = 0
  await assert.rejects(startFetchServer(async () => {
    attempts++
    throw Object.assign(new Error('occupied'), { code: 'EADDRINUSE' })
  }), /32 attempts/)
  assert.equal(attempts, 32)
})

test('environment query is public, uncached and compatible only for the required environment', async () => {
  const requests: http.IncomingHttpHeaders[] = []
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'GET')
    assert.equal(request.url, '/runtime/v1/info')
    requests.push(request.headers)
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(environment))
  })
  const origin = await listen(server)
  try {
    assert.deepEqual(await queryServerEnvironment(`${origin}/?ignored=secret#fragment`), {
      state: 'compatible', currentVersion: SERVER_ENVIRONMENT_VERSION, requiredVersion: SERVER_ENVIRONMENT_VERSION,
      runtimeId: 'node22-bookworm-v1', platform: 'linux/amd64', message: null
    })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].authorization, undefined)
    assert.equal(requests[0].cookie, undefined)
    assert.equal(requests[0]['x-javdex-app-version'], undefined)
    assert.equal(requests[0]['cache-control'], 'no-store')
  } finally { await close(server) }
})

test('a valid older environment requires the Docker image, without inventing version zero', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(environment))
  })
  const origin = await listen(server)
  try {
    assert.deepEqual(await queryServerEnvironment(origin, undefined, SERVER_ENVIRONMENT_VERSION + 1), {
      state: 'imageRequired', currentVersion: SERVER_ENVIRONMENT_VERSION, requiredVersion: SERVER_ENVIRONMENT_VERSION + 1,
      runtimeId: 'node22-bookworm-v1', platform: 'linux/amd64', message: '需要升级服务端Docker镜像'
    })
  } finally { await close(server) }
})

test('a newer environment requires the client rather than an image downgrade', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ...environment, environmentVersion: SERVER_ENVIRONMENT_VERSION + 1, platform: 'linux/arm64' }))
  })
  const origin = await listen(server)
  try {
    assert.deepEqual(await queryServerEnvironment(origin), {
      state: 'clientRequired', currentVersion: SERVER_ENVIRONMENT_VERSION + 1, requiredVersion: SERVER_ENVIRONMENT_VERSION,
      runtimeId: 'node22-bookworm-v1', platform: 'linux/arm64', message: '服务端运行环境较新，请升级此客户端'
    })
  } finally { await close(server) }
})

test('only a missing or unsupported query endpoint is treated as an old image', async t => {
  for (const status of [404, 405, 401, 403, 500, 503, 204]) {
    await t.test(`HTTP ${status}`, async () => {
      const server = http.createServer((_request, response) => {
        response.writeHead(status, { 'Content-Type': 'text/html' })
        response.end('<html>proxy diagnostic: never-reflect-this-secret</html>')
      })
      const origin = await listen(server)
      try {
        const result = await queryServerEnvironment(origin)
        assert.equal(result.state, status === 404 || status === 405 ? 'imageRequired' : 'unavailable')
        assert.equal(result.currentVersion, null)
        assert.equal(result.requiredVersion, SERVER_ENVIRONMENT_VERSION)
        assert.equal(result.runtimeId, null)
        assert.equal(result.platform, null)
        if (result.state === 'imageRequired') assert.equal(result.message, '需要升级服务端Docker镜像')
        else assert.match(result.message ?? '', new RegExp(`HTTP ${status}`))
        assert.doesNotMatch(result.message ?? '', /never-reflect-this-secret|<html>/)
      } finally { await close(server) }
    })
  }
})

test('HTML, unknown response formats and malformed data do not imply an old environment', async t => {
  const cases = [
    { name: 'HTML proxy page', body: '<html>private-proxy-secret</html>', mime: 'text/html' },
    { name: 'JSON disguised as HTML', body: JSON.stringify(environment), mime: 'text/html' },
    { name: 'HTML disguised as JSON', body: '<html>private-proxy-secret</html>', mime: 'application/json' },
    { name: 'invalid JSON', body: '{private-proxy-secret', mime: 'application/json' },
    { name: 'unknown format', body: JSON.stringify({ ...environment, format: 2 }), mime: 'application/json' },
    { name: 'missing version', body: JSON.stringify({ format: 1 }), mime: 'application/json' },
    { name: 'version zero', body: JSON.stringify({ ...environment, environmentVersion: 0 }), mime: 'application/json' },
    { name: 'fractional version', body: JSON.stringify({ ...environment, environmentVersion: 1.5 }), mime: 'application/json' },
    { name: 'unsafe version', body: JSON.stringify({ ...environment, environmentVersion: Number.MAX_SAFE_INTEGER + 1 }), mime: 'application/json' },
    { name: 'non-Linux platform', body: JSON.stringify({ ...environment, platform: 'darwin/arm64' }), mime: 'application/json' },
    { name: 'empty runtime', body: JSON.stringify({ ...environment, runtimeId: '' }), mime: 'application/json' },
    { name: 'null response', body: 'null', mime: 'application/json' }
  ]
  for (const value of cases) {
    await t.test(value.name, async () => {
      const server = http.createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': value.mime })
        response.end(value.body)
      })
      const origin = await listen(server)
      try {
        const result = await queryServerEnvironment(origin)
        assert.equal(result.state, 'unavailable')
        assert.equal(result.currentVersion, null)
        assert.match(result.message ?? '', /响应|JSON/)
        assert.doesNotMatch(result.message ?? '', /private-proxy-secret|<html>|需要升级服务端Docker镜像/)
      } finally { await close(server) }
    })
  }
})

test('the response limit is 16 KiB of decoded bytes, including chunked and compressed bodies', async t => {
  const json = JSON.stringify(environment)
  const cases = [
    { name: 'exactly 16 KiB', body: Buffer.from(json.padEnd(16 * 1024)), chunked: false, compressed: false, state: 'compatible' },
    { name: 'oversized content length', body: Buffer.from(json.padEnd(16 * 1024 + 1)), chunked: false, compressed: false, state: 'unavailable' },
    { name: 'oversized chunked body', body: Buffer.from(json.padEnd(16 * 1024 + 1)), chunked: true, compressed: false, state: 'unavailable' },
    { name: 'multibyte body', body: Buffer.from(JSON.stringify({ ...environment, padding: '汉'.repeat(6000) })), chunked: true, compressed: false, state: 'unavailable' },
    { name: 'oversized decompressed body', body: gzipSync(json.padEnd(16 * 1024 + 1)), chunked: false, compressed: true, state: 'unavailable' }
  ]
  for (const value of cases) {
    await t.test(value.name, async () => {
      const server = http.createServer((_request, response) => {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          ...(value.chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': value.body.length }),
          ...(value.compressed ? { 'Content-Encoding': 'gzip' } : {})
        })
        if (value.chunked) response.write(value.body.subarray(0, 80))
        response.end(value.chunked ? value.body.subarray(80) : value.body)
      })
      const origin = await listen(server)
      try {
        const result = await queryServerEnvironment(origin)
        assert.equal(result.state, value.state)
        if (result.state === 'unavailable') {
          assert.equal(result.currentVersion, null)
          assert.match(result.message ?? '', /响应.*过大/)
        }
      } finally { await close(server) }
    })
  }
})

test('redirects are not followed, either within the origin or to another server', async t => {
  let destinationRequests = 0
  const destination = http.createServer((_request, response) => { destinationRequests++; response.end('unexpected') })
  const otherOrigin = await listen(destination)
  try {
    for (const location of ['/manage/v1/handshake.get?token=private-redirect-secret', `${otherOrigin}/runtime/v1/info`]) {
      await t.test(location.startsWith('/') ? 'same origin' : 'other origin', async () => {
        const paths: string[] = []
        const server = http.createServer((request, response) => {
          paths.push(request.url ?? '')
          response.writeHead(302, { Location: location })
          response.end()
        })
        const origin = await listen(server)
        try {
          const result = await queryServerEnvironment(origin)
          assert.equal(result.state, 'unavailable')
          assert.equal(result.currentVersion, null)
          assert.doesNotMatch(result.message ?? '', /private-redirect-secret/)
          assert.deepEqual(paths, ['/runtime/v1/info'])
          assert.equal(destinationRequests, 0)
        } finally { await close(server) }
      })
    }
  } finally { await close(destination) }
})

test('invalid addresses and URL credentials fail safely without making requests', async () => {
  let requests = 0
  const server = http.createServer((_request, response) => { requests++; response.end('unexpected') })
  const origin = await listen(server)
  try {
    for (const baseUrl of ['not a URL', 'file:///private-local-secret', origin.replace('http://', 'http://user:private-url-secret@')]) {
      const result = await queryServerEnvironment(baseUrl)
      assert.equal(result.state, 'unavailable')
      assert.equal(result.currentVersion, null)
      assert.doesNotMatch(result.message ?? '', /private-local-secret|private-url-secret/)
    }
    assert.equal(requests, 0)
  } finally { await close(server) }
})

test('an unknown runtime remains incompatible even when the environment version is equal', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ...environment, runtimeId: 'node24-new-runtime' }))
  })
  const origin = await listen(server)
  try {
    const result = await queryServerEnvironment(origin)
    assert.equal(result.state, 'unavailable')
    assert.equal(result.currentVersion, SERVER_ENVIRONMENT_VERSION)
    assert.equal(result.runtimeId, 'node24-new-runtime')
    assert.match(result.message ?? '', /不兼容/)
  } finally { await close(server) }
})

test('rechecking reads the actual environment again instead of reusing an earlier snapshot', async () => {
  let version = SERVER_ENVIRONMENT_VERSION
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ...environment, environmentVersion: version }))
  })
  const origin = await listen(server)
  try {
    assert.equal((await queryServerEnvironment(origin)).state, 'compatible')
    version = SERVER_ENVIRONMENT_VERSION + 1
    const result = await queryServerEnvironment(origin)
    assert.equal(result.state, 'clientRequired')
    assert.equal(result.currentVersion, SERVER_ENVIRONMENT_VERSION + 1)
  } finally { await close(server) }
})

test('connection failures and stalled headers or bodies return unavailable within the query deadline', async t => {
  for (const failure of ['disconnect', 'headers', 'body']) {
    await t.test(failure, async () => {
      const server = http.createServer((request, response) => {
        if (failure === 'disconnect') request.socket.destroy()
        else if (failure === 'body') {
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.write('{"format":1,')
        }
      })
      const origin = await listen(server)
      try {
        const startedAt = Date.now()
        const result = await bounded(queryServerEnvironment(origin), 7_000)
        assert.equal(result.state, 'unavailable')
        assert.equal(result.currentVersion, null)
        assert.doesNotMatch(result.message ?? '', /需要升级服务端Docker镜像/)
        if (failure !== 'disconnect') {
          assert.match(result.message ?? '', /超时/)
          assert.ok(Date.now() - startedAt < 6_500)
        }
      } finally { await close(server) }
    })
  }
})

test('a stalled real HTTP body is explicitly cancelled after GC, before the unchanged deadline', async () => {
  // A fresh process lets this run under both plain Node and Electron without
  // changing the host's GC settings or mocking away Fetch's abort propagation.
  // Compile the real modules before launching the child: its unchanged 10s
  // watchdog must measure execution, not a cold TS loader on a mounted source tree.
  const root = path.resolve(__dirname, '../../..')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-http-gc-'))
  const fixture = path.join(directory, 'fixture.cjs')
  try {
    await build({
      stdin: { contents: "export { queryServerEnvironment } from './packages/http/src/serverEnvironmentClient'; export { listenFetchServer } from './scripts/test-http'", resolveDir: root, loader: 'ts' },
      outfile: fixture, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
      alias: { '@shared': path.join(root, 'packages/contracts/src') }, logLevel: 'silent'
    })
    const probe = String.raw`
    const assert = require('node:assert/strict')
    const http = require('node:http')
    const { queryServerEnvironment, listenFetchServer } = require(process.env.JAVDEX_TEST_GC_MODULE)
    async function run() {
      assert.equal(typeof global.gc, 'function')
      let peerClosed
      const closed = new Promise(resolve => { peerClosed = resolve })
      let requests = 0, collections = 0
      const server = http.createServer((request, response) => {
        requests++
        request.socket.once('close', peerClosed)
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.write('{"format":1,')
      })
      const port = await listenFetchServer(server)
      const collection = setInterval(() => { collections++; global.gc() }, 50)
      let deadline, closeDeadline
      try {
        const started = Date.now()
        const result = await Promise.race([
          queryServerEnvironment('http://127.0.0.1:' + port),
          new Promise((_resolve, reject) => {
            deadline = setTimeout(() => reject(new Error('body exceeds unchanged 7000ms deadline')), 7000)
          })
        ])
        assert.equal(result.state, 'unavailable')
        assert.equal(result.currentVersion, null)
        assert.equal(requests, 1, 'the real HTTP request must reach the stalled response body')
        assert.ok(collections > 0, 'the body must remain pending across real GC')
        assert.match(result.message, /超时/)
        assert.ok(Date.now() - started < 6500)
        await Promise.race([closed, new Promise((_resolve, reject) => {
          closeDeadline = setTimeout(() => reject(new Error('stalled response socket was not closed')), 1000)
        })])
        console.log('GC stalled-body regression passed')
      } finally {
        console.error('HTTP/GC fixture', JSON.stringify({ port, requests, collections }))
        clearInterval(collection)
        clearTimeout(deadline)
        clearTimeout(closeDeadline)
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
      }
    }
    run().catch(error => { console.error(error); process.exitCode = 1 })
  `
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--expose-gc', '-e', probe
    ], { cwd: root, timeout: 10_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', JAVDEX_TEST_GC_MODULE: fixture } })
    assert.match(stdout, /GC stalled-body regression passed/)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('TLS trust is checked before HTTP, and owned transports close on success and errors', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-environment-tls-'))
  const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test', '-keyout', key, '-out', cert], { stdio: 'ignore' })
  const expectedFingerprint = createHash('sha256').update(new X509Certificate(fs.readFileSync(cert)).raw).digest('hex')
  let requests = 0
  let status = 200
  let body = JSON.stringify(environment)
  const connections = new Set<Promise<void>>()
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (request, response) => {
    requests++
    assert.equal(request.headers.authorization, undefined)
    assert.equal(request.headers.cookie, undefined)
    assert.equal(request.headers['x-javdex-app-version'], undefined)
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(body)
  })
  server.on('connection', socket => {
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
    connections.add(closed)
    void closed.then(() => connections.delete(closed))
  })
  const origin = await listen(server, 'https')
  try {
    await t.test('untrusted certificate', async () => {
      const result = await queryServerEnvironment(origin)
      assert.equal(result.state, 'unavailable')
      assert.match(result.message ?? '', /HTTPS.*证书/)
      assert.equal(requests, 0)
    })
    await t.test('pending then accepted trust', async () => {
      let approve!: () => void, observed!: () => void
      const seen = new Promise<void>(resolve => { observed = resolve })
      const approval = new Promise<void>(resolve => { approve = resolve })
      const query = queryServerEnvironment(origin, async (fingerprint, publiclyTrusted) => {
        assert.equal(fingerprint, expectedFingerprint)
        assert.equal(publiclyTrusted, false)
        observed()
        await approval
      })
      try {
        await bounded(seen, 1_000)
        assert.equal(requests, 0, 'no HTTP request is sent before certificate consent')
        approve()
        assert.equal((await bounded(query, 1_000)).state, 'compatible')
        await bounded(Promise.all([...connections]), 1_000)
        assert.equal(connections.size, 0)
      } finally { approve() }
    })
    await t.test('refused trust', async () => {
      const before = requests
      const result = await queryServerEnvironment(origin, async () => { throw new Error('private-trust-details') })
      assert.equal(result.state, 'unavailable')
      assert.doesNotMatch(result.message ?? '', /private-trust-details/)
      assert.equal(requests, before)
      await bounded(Promise.all([...connections]), 1_000)
    })
    for (const value of [
      { name: 'HTTP error', status: 401, body: JSON.stringify(environment), state: 'unavailable' },
      { name: 'missing endpoint', status: 404, body: '', state: 'imageRequired' },
      { name: 'malformed response', status: 200, body: '{invalid-json', state: 'unavailable' },
      { name: 'oversized response', status: 200, body: JSON.stringify(environment).padEnd(16 * 1024 + 1), state: 'unavailable' }
    ]) {
      await t.test(`${value.name} after accepted trust`, async () => {
        status = value.status
        body = value.body
        assert.equal((await queryServerEnvironment(origin, async () => undefined)).state, value.state)
        await bounded(Promise.all([...connections]), 1_000)
        assert.equal(connections.size, 0)
      })
    }
    await t.test('stalled certificate confirmation is bounded and closes the TLS socket', async () => {
      let approve!: () => void
      const approval = new Promise<void>(resolve => { approve = resolve })
      const before = requests
      const query = queryServerEnvironment(origin, async () => { await approval })
      try {
        const result = await bounded(query, 6_500)
        assert.equal(result.state, 'unavailable')
        assert.match(result.message ?? '', /超时/)
        assert.equal(requests, before)
        await bounded(Promise.all([...connections]), 1_000)
      } finally { approve(); await bounded(query, 1_000) }
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(requests, before, 'late certificate approval cannot send a timed-out request')
    })
  } finally { await close(server); fs.rmSync(directory, { recursive: true, force: true }) }
})
