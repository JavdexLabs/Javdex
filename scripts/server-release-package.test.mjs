import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { createServer, request } from 'node:http'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { build, transform } from 'esbuild'
import { t } from 'tar'
import { describeRelease, packageRelease } from './server-release-package.mjs'
import { isServerReleasePath } from '../packages/contracts/src/serverUpdateTypes.ts'
import httpServer from '../packages/http/src/server.ts'
import { requestBusiness } from '../apps/server/src/updater/businessHttp.ts'
import updateClient from '../packages/http/src/updateClient.ts'
import { waitForUpdateStatus } from './server-updater-smoke-wait.mjs'

test('single-container smoke entrypoint compiles for the CommonJS TS loader used by npm', async () => {
  const sourcefile = 'scripts/server-updater-smoke.ts'
  await transform(fs.readFileSync(sourcefile, 'utf8'), { sourcefile, loader: 'ts', format: 'cjs', target: 'node22', logLevel: 'silent' })
})

test('root Docker context includes both complete managed runtime closures', () => {
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8')
  const rules = fs.readFileSync('.dockerignore', 'utf8').trim().split(/\r?\n/)
  assert.equal(rules[0], '*', 'only explicit build closures should enter the image context')
  for (const directory of ['out/server', 'out/updater']) {
    assert.ok(dockerfile.includes(`COPY ${directory}`))
    assert.ok(rules.includes(`!${directory}/`), `${directory} must be visible to Docker`)
    assert.ok(rules.includes(`!${directory}/**`), `${directory} contents must be visible to Docker`)
  }
})

test('smoke waits for the pinned updater listener after the business process is already ready', { timeout: 5000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-smoke-listener-'))
  const key = path.join(root, 'key.pem'), cert = path.join(root, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1', '-subj', '/CN=isolated-smoke', '-keyout', key, '-out', cert], { stdio: 'ignore' })
  const token = 'c'.repeat(64), serverId = randomUUID(), catalogId = randomUUID()
  let requests = 0
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (incoming, response) => {
    requests++; assert.equal(incoming.headers.authorization, `Bearer ${token}`); incoming.resume()
    response.end(JSON.stringify({ protocolVersion: 1, paired: true, serverId, catalogId, currentVersion: '0.9.0-beta.1', job: null }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  const client = new updateClient.ServerUpdateClient({ protocolVersion: 1, url: `https://127.0.0.1:${port}/`, token, serverId, catalogId,
    certificateSha256: createHash('sha256').update(new X509Certificate(fs.readFileSync(cert)).raw).digest('hex') })
  const listening = new Promise(resolve => setTimeout(() => server.listen(port, '127.0.0.1', resolve), 50))
  try {
    const status = await waitForUpdateStatus(() => client.control('status'), { timeoutMs: 1000, intervalMs: 10 })
    assert.equal(status.currentVersion, '0.9.0-beta.1')
    assert.equal(requests, 1)
  } finally {
    await listening
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('smoke status waiting is bounded and never retries certificate, identity or authorization failures', async () => {
  for (const message of ['更新助手证书与配对信息不一致，请核对宿主机', '更新助手与已配对服务端身份不一致', '更新授权无效']) {
    let calls = 0
    const error = new Error(message)
    await assert.rejects(waitForUpdateStatus(async () => { calls++; throw error }), failure => failure === error)
    assert.equal(calls, 1)
  }
  let calls = 0
  const unavailable = new Error('无法连接更新助手')
  await assert.rejects(waitForUpdateStatus(async () => { calls++; throw unavailable }, { timeoutMs: 30, intervalMs: 10 }), error => error === unavailable)
  assert.ok(calls > 1 && calls < 20)
})

function replayBusinessUidProbe(businessUid, extraBusiness = false) {
  const source = ts.createSourceFile('scripts/server-updater-smoke.ts', fs.readFileSync('scripts/server-updater-smoke.ts', 'utf8'), ts.ScriptTarget.Latest, true)
  const probes = []
  const visit = node => {
    if (ts.isStringLiteral(node) && node.text.includes("readdirSync('/proc')") && node.text.includes('/cmdline')) probes.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(probes.length, 1, 'replay the actual Docker node -e UID probe')
  const probe = probes[0]
  const files = new Map([
    ['/proc/42/cmdline', ['/usr/local/bin/node', '/program/releases/verified/index.js', 'start'].join('\0')],
    ['/proc/42/status', `Uid:\t${businessUid}\t${businessUid}\t${businessUid}\t${businessUid}\n`],
    // docker exec runs this diagnostic as root; its inline source mentions the business path.
    ['/proc/43/cmdline', ['/usr/local/bin/node', '-e', probe].join('\0')],
    ['/proc/43/status', 'Uid:\t0\t0\t0\t0\n']
  ])
  if (extraBusiness) {
    files.set('/proc/44/cmdline', ['/usr/local/bin/node', '/program/releases/other/index.js', 'start'].join('\0'))
    files.set('/proc/44/status', 'Uid:\t0\t0\t0\t0\n')
  }
  const output = []
  runInNewContext(probe, { console: { log: value => output.push(String(value)) }, require: name => {
    assert.equal(name, 'node:fs')
    return { readdirSync: directory => { assert.equal(directory, '/proc'); return extraBusiness ? ['42', '43', '44'] : ['42', '43'] },
      readFileSync: file => { assert.ok(files.has(file), `unexpected probe path ${file}`); return files.get(file) } }
  } })
  return output
}

test('business UID probe excludes its own root node -e diagnostic process', () => {
  assert.deepEqual(replayBusinessUidProbe(1000), ['1000'])
})

test('business UID probe still exposes a genuinely root or duplicate business process', () => {
  assert.deepEqual(replayBusinessUidProbe(0), ['0'])
  assert.deepEqual(replayBusinessUidProbe(1000, true), ['1000', '0'])
})

test('container readiness preserves the internal authority across mapped host ports', { timeout: 5000 }, async () => {
  const server = new httpServer.WebServer({ username: 'probe', passwordHash: '', staticRoot: '.', catalog: {},
    accessHosts: ['127.0.0.1'], probes: { live: () => ({ status: 'ok' }), ready: () => ({ ready: true }) } })
  const internalPort = await server.start(0, '127.0.0.1')
  // Real HTTP port forwarding exercises the same Host guard as Docker port mapping, without claiming container acceptance.
  const proxy = createServer((incoming, response) => {
    const upstream = request({ hostname: '127.0.0.1', port: internalPort, path: incoming.url, method: incoming.method, headers: incoming.headers }, forwarded => {
      response.writeHead(forwarded.statusCode, forwarded.headers); forwarded.pipe(response)
    })
    upstream.on('error', () => { response.writeHead(502); response.end() })
    incoming.pipe(upstream)
  })
  try {
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${proxy.address().port}`
    const rejected = await fetch(`${base}/ready`)
    assert.equal(rejected.status, 403, 'the external port must still be rejected by the Host guard')
    await rejected.arrayBuffer()
    const ready = await requestBusiness(new URL('/ready', base), `127.0.0.1:${internalPort}`, { timeoutMs: 1000 })
    assert.equal(ready.status, 200)
    assert.deepEqual(JSON.parse(ready.body), { ready: true })
  } finally {
    proxy.closeAllConnections()
    await new Promise(resolve => proxy.close(resolve))
    await server.stop()
  }
})

function fixture(root) {
  const files = {
    'package.json': JSON.stringify({ version: '0.8.1' }),
    'build-info.json': JSON.stringify({ format: 1, build: 'a'.repeat(40), targetSchema: 20 }),
    'index.js': '// test', 'webCatalogWorker.js': '// test', 'web/index.html': '<title>test</title>',
    LICENSE: 'synthetic fixture', NOTICE: 'synthetic fixture',
    'node_modules/better-sqlite3/package.json': '{}', 'node_modules/sharp/package.json': '{}',
    'node_modules/lib/test-data': 'actual bytes'
  }
  for (const [name, content] of Object.entries(files)) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
}
test('publisher archives a complete exact closure, dereferences internal links and excludes npm executables', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-package-test-'))
  try {
    const source = path.join(temporary, 'closure')
    fixture(source)
    fs.mkdirSync(path.join(source, 'node_modules/.bin'))
    fs.symlinkSync('../lib/test-data', path.join(source, 'node_modules/.bin/tool'))
    fs.symlinkSync('test-data', path.join(source, 'node_modules/lib/alias'))
    const archive = path.join(temporary, 'release.tar.gz')
    const result = await packageRelease(source, archive, 'linux/amd64')
    const names = []; let bytes = 0
    await t({ file: archive, strict: true, onReadEntry: entry => { names.push(entry.path); bytes += entry.size; assert.equal(entry.type, 'File') } })
    assert.equal(bytes, result.unpackedBytes)
    assert.deepEqual(names.sort(), [...Object.keys(result.descriptor.files), 'release.json'].sort())
    assert.equal(names.some(name => name.includes('.bin')), false)
    assert.equal(result.descriptor.files['node_modules/lib/alias'].sha256, result.descriptor.files['node_modules/lib/test-data'].sha256)
    assert.match(result.sha256, /^[a-f0-9]{64}$/)
    fs.symlinkSync('/etc/passwd', path.join(source, 'escape'))
    await assert.rejects(describeRelease(source, 'linux/amd64'), /escapes/)
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
})

test('publisher uses the receiver version and filename constraints', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-release-contract-'))
  try {
    fixture(root)
    for (const version of ['0.9.0-beta.1', '0.9.0']) {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }))
      assert.equal((await describeRelease(root, 'linux/amd64')).version, version)
    }
    for (const version of ['0.9.0-beta.01', '0.09.0', '0.9.0-beta..1']) {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }))
      await assert.rejects(describeRelease(root, 'linux/amd64'))
    }
    assert.equal(isServerReleasePath('x'.repeat(1025)), false)
    assert.equal(isServerReleasePath('node_modules/../escape'), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('container publisher runs from its standalone bundle without source TS or npm dependencies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-container-publisher-'))
  try {
    const source = path.join(root, 'closure')
    fixture(source)
    const publisher = path.join(root, 'package.mjs')
    await build({ entryPoints: ['scripts/server-release-package.mjs'], outfile: publisher, bundle: true, platform: 'node', target: 'node22', format: 'esm',
      banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } })
    const metadata = spawnSync(process.execPath, [publisher, 'metadata', source, 'linux/amd64'], { cwd: root, encoding: 'utf8' })
    assert.equal(metadata.status, 0, metadata.stderr)
    assert.equal(JSON.parse(fs.readFileSync(path.join(source, 'release.json'), 'utf8')).version, '0.8.1')
    const archive = path.join(root, 'release.tar.gz')
    const packaged = spawnSync(process.execPath, [publisher, 'archive', source, archive], { cwd: root, encoding: 'utf8' })
    assert.equal(packaged.status, 0, packaged.stderr)
    assert.ok(fs.statSync(archive).size > 0)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
