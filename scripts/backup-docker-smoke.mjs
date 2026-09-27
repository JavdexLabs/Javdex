import { createServer } from 'node:net'
import assert from 'node:assert/strict'
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

// Uses only a uniquely named test container/volume. Never touches the user's local server.
const name = `javdex-backup-smoke-${randomUUID()}`
const volume = `${name}-data`
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-backup-smoke-'))
// The production image runs as node (uid 1000), unlike the Linux CI host user.
// This directory contains test-only configuration and must be traversable across the bind mount.
fs.chmodSync(configDir, 0o755)
const image = process.env.JAVDEX_BACKUP_SMOKE_IMAGE ?? 'javdex-server:backup-verification'
const version = JSON.parse(fs.readFileSync('out/server/package.json', 'utf8')).version
// A stalled local transport must fail the smoke instead of waiting indefinitely.
const fetch = (input, init = {}) => globalThis.fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(15_000) })
const digest = data => createHash('sha256').update(data).digest('hex')
// Keep the harness alive during startup fetches whose sockets/timers may be unreferenced.
const keepAlive = setInterval(() => {}, 1000)
function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
docker('info', '--format', '{{.ServerVersion}}')
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
fs.writeFileSync(path.join(configDir, 'server.json'), JSON.stringify({
  port, accessHosts: ['127.0.0.1'], dataDir: '/data', imagesDir: '/data/media_assets',
  mediaMounts: { library: '/media' }, web: { username: 'viewer' }
}), { mode: 0o644 })
let base
let identity
const secret = randomBytes(32).toString('base64url')
async function post(operation, input, authorization = secret, mutation = false) {
  const response = await fetch(`${base}/manage/v1/${operation}`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json',
      'X-Javdex-App-Version': version, ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) },
    body: JSON.stringify({ ...(mutation ? { operationId: randomUUID(), writerEpoch: identity.writerEpoch, expectedVersions: {} } : {}), ...(identity ? { serverId: identity.serverId, catalogId: identity.catalogId } : {}), input })
  })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  return result
}
async function healthy() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/ready`)).ok) return } catch { /* starting */ }
    await delay(250)
  }
  const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  console.error(`${logs.stdout ?? ''}${logs.stderr ?? ''}`.replace(/(token|secret)[^\n]*/gi, '$1 [redacted]'))
  assert.fail('isolated server did not become ready')
}
async function wait(id, phase) {
  for (let i = 0; i < 200; i++) {
    let job
    try { job = (await post('backup.control', { action: 'status', id })).jobs[0] }
    catch (error) { if (!(error instanceof TypeError)) throw error; await delay(100); continue }
    if (job.phase === phase) return job
    assert.ok(!['failed', 'recoveryRequired'].includes(job.phase), job.error)
    await delay(50)
  }
  assert.fail(`timeout: ${phase}`)
}
try {
  docker('run', '-d', '--name', name, '-p', `127.0.0.1:${port}:${port}`, '-v', `${volume}:/data`,
    '-v', `${configDir}:/config:ro`, '-e', 'JAVDEX_WEB_PASSWORD=backup-smoke-test-only',
    image, 'start', '--config', '/config/server.json')
  base = `http://127.0.0.1:${port}`
  await healthy()
  identity = (await post('handshake.get', {}, null)).identity
  const token = JSON.parse(docker('exec', name, 'node', 'index.js', 'bind', '--config', '/config/server.json'))
  const claimed = await post('writer.claim', { kind: 'initialBind', oneTimeToken: token.oneTimeToken,
    candidate: { claimId: randomUUID(), secretDigest: digest(secret) } }, null)
  identity = { ...identity, writerEpoch: claimed.writerEpoch ?? claimed.identity?.writerEpoch ?? 1 }
  await post('playlists.create', { name: '备份清单' }, secret, true)
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: {
    Origin: base, 'Content-Type': 'application/json', 'X-Javdex-Client': 'web'
  }, body: JSON.stringify({ username: 'viewer', password: 'backup-smoke-test-only', remember: true }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const backupId = randomUUID()
  await post('backup.control', { action: 'create', id: backupId })
  const backup = await wait(backupId, 'completed')
  assert.equal(backup.summary.counts.playlists, 1)
  await post('playlists.create', { name: '仅存在目标的清单' }, secret, true)
  const chunks = []
  for (let offset = 0; offset < backup.bytes;) {
    const response = await fetch(`${base}/manage/v1/backups/${backupId}?offset=${offset}`, {
      headers: { Origin: base, Authorization: `Bearer ${secret}`, 'X-Javdex-App-Version': version }
    })
    assert.equal(response.status, 206)
    const bytes = Buffer.from(await response.arrayBuffer()); chunks.push(bytes); offset += bytes.length
  }
  const bytes = Buffer.concat(chunks) // This fixture is a tiny catalog, not production transfer code.
  assert.equal(digest(bytes), backup.sha256)
  const restoreId = randomUUID()
  await post('backup.control', { action: 'receive', id: restoreId, bytes: bytes.length, sha256: backup.sha256 })
  const midpoint = Math.floor(bytes.length / 2)
  async function upload(offset, data) {
    const response = await fetch(`${base}/manage/v1/backups/${restoreId}?offset=${offset}`, {
      method: 'PUT', headers: { Origin: base, Authorization: `Bearer ${secret}`, 'X-Javdex-App-Version': version }, body: data
    })
    assert.equal(response.status, 200, await response.clone().text())
    return (await response.json()).offset
  }
  assert.equal(await upload(0, bytes.subarray(0, midpoint)), midpoint)
  docker('restart', name); await healthy()
  assert.equal((await post('backup.control', { action: 'status', id: restoreId })).jobs[0].transferred, midpoint)
  assert.equal(await upload(0, bytes.subarray(0, midpoint)), midpoint)
  await upload(midpoint, bytes.subarray(midpoint))
  await post('backup.control', { action: 'inspect', id: restoreId }); await wait(restoreId, 'ready')
  const preview = (await post('backup.control', { action: 'preview', id: restoreId, mappings: [] })).jobs[0].preview
  try { await post('backup.control', { action: 'restore', id: restoreId, digest: preview.digest }) }
  catch (error) { if (!(error instanceof TypeError)) throw error } // A revoked connection can lose the response; query the durable job.
  const completed = await wait(restoreId, 'completed')
  const previous = identity
  identity = undefined
  identity = (await post('handshake.get', {}, null)).identity
  assert.equal(identity.catalogId, completed.newCatalogId)
  assert.equal(identity.serverId, previous.serverId)
  assert.notEqual(identity.catalogId, previous.catalogId)
  assert.equal((await post('backup.control', { action: 'restore', id: restoreId, digest: preview.digest })).jobs[0].phase, 'completed')
  assert.equal((await fetch(`${base}/api/collections`, { headers: { Cookie: cookie } })).status, 401)
  assert.equal((await post('backup.control', { action: 'status', id: completed.automaticBackupId })).jobs[0].phase, 'completed')
  docker('restart', name); await healthy()
  const verificationId = randomUUID()
  await post('backup.control', { action: 'create', id: verificationId })
  assert.equal((await wait(verificationId, 'completed')).summary.counts.playlists, 1)
  // Exercise the actual packaged desktop exporter, including encrypted images, then
  // restore its host-platform paths into a Docker mount subdirectory.
  const fixtureDir = path.join(configDir, 'host-fixture')
  const require = createRequire(import.meta.url)
  const fixture = spawnSync(require('electron'), ['--require', './scripts/register-test-paths.cjs',
    '--import', 'tsx', 'scripts/backup-host-fixture.ts', fixtureDir], {
    encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 45000
  })
  assert.equal(fixture.status, 0, fixture.stderr || fixture.error?.message)
  const imported = fs.readFileSync(path.join(fixtureDir, 'fixture.javdex-backup'))
  const importId = randomUUID()
  await post('backup.control', { action: 'receive', id: importId, bytes: imported.length, sha256: digest(imported) })
  const uploadImport = await fetch(`${base}/manage/v1/backups/${importId}?offset=0`, {
    method: 'PUT', headers: { Origin: base, Authorization: `Bearer ${secret}`, 'X-Javdex-App-Version': version }, body: imported
  })
  assert.equal(uploadImport.status, 200)
  await post('backup.control', { action: 'inspect', id: importId })
  const source = await wait(importId, 'ready')
  assert.equal(source.summary.sourcePlatform, process.platform)
  assert.equal(source.summary.counts.images, 1)
  assert.deepEqual(source.summary.missingImages, ['samples/缺失旧样张.enc'])
  const targetDirectory = '/media/子目录 测试'
  docker('exec', '-u', 'root', name, 'node', '-e', 'const fs=require("fs");fs.mkdirSync(process.argv[1],{recursive:true});fs.writeFileSync(process.argv[1]+"/电影 avi.avi","original-video-untouched");fs.chownSync(process.argv[1],1000,1000)', targetDirectory)
  const mapped = (await post('backup.control', { action: 'preview', id: importId,
    mappings: [{ sourceRootId: 1, target: { kind: 'mount', mountSelectionId: 'library', relativePath: '子目录 测试' } }]
  })).jobs[0].preview
  assert.equal(mapped.missingResources, 0); assert.equal(mapped.removedResources, 0)
  try { await post('backup.control', { action: 'restore', id: importId, digest: mapped.digest }) }
  catch (error) { if (!(error instanceof TypeError)) throw error }
  const importedJob = await wait(importId, 'completed')
  identity.catalogId = importedJob.newCatalogId
  const restored = JSON.parse(docker('exec', name, 'node', '-e', 'const D=require("better-sqlite3"),fs=require("fs");const d=new D("/data/library.db",{readonly:true});const v=d.prepare("SELECT cover_path FROM videos").get();console.log(JSON.stringify({image:fs.readFileSync("/data/media_assets/"+v.cover_path,"utf8"),locator:d.prepare("SELECT locator FROM video_resources").get().locator}))'))
  assert.equal(restored.image, 'original-image-plaintext')
  assert.equal(restored.locator, `${targetDirectory}/电影 avi.avi`)
  const returnId = randomUUID()
  await post('backup.control', { action: 'create', id: returnId }); const returning = await wait(returnId, 'completed')
  const removal = (await post('backup.control', { action: 'previewRemoval', id: returnId })).removal
  assert.ok(removal.digest)
  assert.equal(removal.host, 'remote')
  const response = await fetch(`${base}/manage/v1/backups/${returnId}?offset=0`, {
    headers: { Origin: base, Authorization: `Bearer ${secret}`, 'X-Javdex-App-Version': version }
  })
  assert.equal(response.status, 206)
  const returned = Buffer.from(await response.arrayBuffer())
  assert.equal(digest(returned), returning.sha256)
  const returnFile = path.join(fixtureDir, 'server-export.javdex-backup'); fs.writeFileSync(returnFile, returned)
  const roundtrip = spawnSync(require('electron'), ['--require', './scripts/register-test-paths.cjs', '--import', 'tsx',
    'scripts/backup-host-fixture.ts', fixtureDir, returnFile], {
    encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 45000
  })
  assert.equal(roundtrip.status, 0, roundtrip.stderr || roundtrip.error?.message)
  // The server reserves 30 seconds after a download for chunk/resume requests.
  await delay(31_000)
  await post('backup.control', { action: 'removeRecord', id: returnId, deleteFiles: false })
  assert.ok(!(await post('backup.control', { action: 'list' })).jobs.some(job => job.id === returnId))
  docker('restart', name); await healthy()
  assert.ok(!(await post('backup.control', { action: 'list' })).jobs.some(job => job.id === returnId))
  assert.equal((await post('backup.control', { action: 'status', id: returnId })).jobs[0].phase, 'completed')
  const retained = await fetch(`${base}/manage/v1/backups/${returnId}?offset=0`, {
    headers: { Origin: base, Authorization: `Bearer ${secret}`, 'X-Javdex-App-Version': version }
  })
  assert.equal(retained.status, 206)
  assert.equal(digest(Buffer.from(await retained.arrayBuffer())), returning.sha256)
  const cleanupId = randomUUID()
  await post('backup.control', { action: 'create', id: cleanupId }); await wait(cleanupId, 'completed')
  const cleanup = (await post('backup.control', { action: 'previewRemoval', id: cleanupId })).removal
  assert.ok(cleanup.fileCount > 0)
  await post('backup.control', { action: 'removeRecord', id: cleanupId, deleteFiles: true, digest: cleanup.digest })
  assert.ok(!(await post('backup.control', { action: 'list' })).jobs.some(job => job.id === cleanupId))
  assert.equal(docker('exec', name, 'node', '-e', 'console.log(require("fs").existsSync(process.argv[1]))', `/data/backups/${cleanupId}.javdex-backup`), 'false')
  console.log('PASS: deletion confirmation preview and optional managed backup cleanup over HTTP.')
  console.log('PASS: HTTP record deletion survives restart and preserves the downloadable backup file.')
  console.log('PASS: isolated Docker backup/download, interrupted upload resume, writer-preserving restore, stale browser-session rejection, repeat confirmation, and restart.')
  console.log(`PASS: compiled desktop export (${process.platform}), encrypted images, source preservation, and Docker subdirectory mapping.`)
  console.log(`PASS: Docker backup restored into an isolated ${process.platform} local catalog with images and resource mapping.`)
} finally {
  clearInterval(keepAlive)
  spawnSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore' })
  spawnSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' })
  // Deliberately retain the small host config directory for failure diagnostics.
}
