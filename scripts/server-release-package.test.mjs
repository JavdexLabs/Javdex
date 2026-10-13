import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { createServer, request } from 'node:http'
import { build, transform } from 'esbuild'
import { t } from 'tar'
import { describeRelease, packageRelease } from './server-release-package.mjs'
import { isServerReleasePath } from '../packages/contracts/src/serverUpdateTypes.ts'
import httpServer from '../packages/http/src/server.ts'
import { requestBusiness } from '../apps/server/src/updater/businessHttp.ts'

test('single-container smoke entrypoint compiles for the CommonJS TS loader used by npm', async () => {
  const sourcefile = 'scripts/server-updater-smoke.ts'
  await transform(fs.readFileSync(sourcefile, 'utf8'), { sourcefile, loader: 'ts', format: 'cjs', target: 'node22', logLevel: 'silent' })
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
