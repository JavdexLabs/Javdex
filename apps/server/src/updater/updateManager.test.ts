import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto'
import { afterEach, mock, test } from 'node:test'
import type { ServerUpdateManifest, SignedServerUpdate } from '@shared/serverUpdateTypes'
import type { DeploymentRelease, DeploymentSnapshot, UpdateDeployment } from './deployment'
import { verifyUpdateManifest, checkUpdateTarget, sha256 } from './manifest'
import { ServerUpdateManager } from './updateManager'
import { updateBundlePrefix } from '@http/updateBundle'
import { uploadServerUpdateBundle } from '@http/updateClient'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }) })
const keys = generateKeyPairSync('ed25519')
const trusted = { release: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
const archive = Buffer.from('independent known update archive bytes')
const target: ServerUpdateManifest = {
  format: 1, version: '0.8.1', build: 'a'.repeat(40), expiresAt: '2099-01-01T00:00:00.000Z', platform: 'linux/amd64',
  sourceSchemas: [19], targetSchema: 20, minUpdaterProtocol: 1, runtime: 'node22-bookworm-v1',
  archive: { url: 'https://github.com/JavdexLabs/Javdex/releases/download/v0.8.1/Javdex-server.tar.gz', bytes: archive.length, unpackedBytes: archive.length, sha256: sha256(archive) }
}
function signed(manifest = target): SignedServerUpdate {
  const payload = JSON.stringify(manifest)
  return { keyId: 'release', payload, signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64') }
}
class FixtureDeployment implements UpdateDeployment {
  current: DeploymentSnapshot = { identity: { version: '0.8.0', schema: 19, platform: 'linux/amd64', runtime: 'node22-bookworm-v1', serverId: randomUUID(), catalogId: randomUUID(), dataDir: '/data', imagesDir: '/data/media_assets', busy: false, port: 8096 }, release: `0.8.0-${'d'.repeat(64)}`, configHash: 'f'.repeat(64), roots: ['/data'] }
  events: string[] = []
  failure: string | null = null
  stopped = false
  async inspect(): Promise<DeploymentSnapshot> { return structuredClone(this.current) }
  async prepare(_manifest: ServerUpdateManifest, file?: string): Promise<void> { this.events.push('prepare'); if (file) assert.deepEqual(fs.readFileSync(file), archive) }
  async stop(): Promise<void> { this.stopped = true; this.events.push('stop') }
  async install(manifest: DeploymentRelease): Promise<void> { this.events.push('install'); this.current.identity.schema = manifest.targetSchema; this.current.identity.version = manifest.version; this.current.release = `${manifest.version}-${manifest.archive.sha256}` }
  async verify(): Promise<void> { this.events.push('verify'); if (this.failure === 'verify') throw new Error('worker failed after migration') }
  async activate(): Promise<void> { this.events.push('activate'); if (this.failure === 'activate') throw new Error('connection lost after activation'); this.stopped = false }
  async cleanup(): Promise<void> {}
  async resume(): Promise<void> { this.events.push('resume'); if (this.failure === 'resume') throw new Error('resume failed'); this.stopped = false }
}
function fixture(): { dir: string; deployment: FixtureDeployment; manager: ServerUpdateManager } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-updater-test-'))
  directories.push(dir)
  const deployment = new FixtureDeployment()
  return { dir, deployment, manager: new ServerUpdateManager(dir, trusted, deployment) }
}
const image: DeploymentRelease = { version: target.version, build: target.build, platform: target.platform,
  runtime: target.runtime, sourceSchemas: target.sourceSchemas, targetSchema: target.targetSchema, archive: { sha256: target.archive.sha256 } }

for (const phase of ['restored', 'backup', 'restoring']) test(`published updater journal ${phase} preserves the program volume on manager replacement`, async () => {
  const f = fixture()
  const id = randomUUID()
  const jobDir = path.join(f.dir, 'jobs', id)
  fs.mkdirSync(jobDir)
  const snapshot = path.join(jobDir, 'legacy-snapshot')
  fs.writeFileSync(snapshot, 'administrator recovery material')
  const saved = { id, version: target.version, phase, receivedBytes: archive.length, totalBytes: archive.length,
    updatedAt: new Date().toISOString(), message: null, signed: signed(), offline: false,
    deployment: { ...f.deployment.current, identity: { ...f.deployment.current.identity, estimatedBytes: 1000 } } }
  fs.writeFileSync(path.join(f.dir, 'current.json'), JSON.stringify(saved))
  fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(saved))
  const restarted = new ServerUpdateManager(f.dir, trusted, f.deployment)
  await restarted.recover()
  assert.equal((await restarted.status(false)).job?.phase, phase === 'restored' ? 'failed' : 'recoveryRequired')
  assert.equal(restarted.recoveryRequired, phase !== 'restored')
  assert.deepEqual(f.deployment.events, [], 'no old snapshot restore, migration or automatic restart')
  assert.equal(fs.readFileSync(snapshot, 'utf8'), 'administrator recovery material')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, 'current.json'), 'utf8')), saved, 'read normalization does not overwrite the old journal')
  if (phase === 'restored') await restarted.setTarget(signed())
  else await assert.rejects(restarted.setTarget(signed()), /人工恢复/)
})

test('image upgrade installs and verifies without copying library data', async () => {
  const f = fixture()
  await f.manager.installImage(image, 100, async () => { f.deployment.events.push('image') })
  assert.deepEqual(f.deployment.events, ['image', 'stop', 'install', 'verify', 'activate'])
  assert.equal((await f.manager.status()).job?.phase, 'complete')
  assert.equal(f.deployment.current.identity.version, image.version)
  await f.manager.installImage(image, 100, async () => assert.fail('same version'))
  await f.manager.installImage({ ...image, version: '0.8.0' }, 100, async () => assert.fail('downgrade'))
  assert.equal(f.deployment.events.length, 5)
})
test('failed image remains in maintenance after restart and cannot retry over migrated data', async () => {
  const f = fixture()
  f.deployment.failure = 'verify'
  await f.manager.installImage(image, 100, async () => {})
  assert.equal((await f.manager.status(false)).job?.phase, 'recoveryRequired')
  assert.equal(f.deployment.current.identity.version, image.version)
  assert.equal(f.deployment.stopped, true)
  const restarted = new ServerUpdateManager(f.dir, trusted, f.deployment)
  await restarted.recover()
  await assert.rejects(restarted.installImage(image, 100, async () => assert.fail('must not retry')), /人工恢复/)
  assert.equal(f.deployment.events.filter(event => event === 'install').length, 1)
})

test('image preparation failure and unsupported schema never stop business', async () => {
  for (const unsupported of [false, true]) {
    const f = fixture()
    await f.manager.installImage({ ...image, sourceSchemas: unsupported ? [20] : [19] }, 100, async () => { throw new Error('corrupt image') })
    assert.equal((await f.manager.status()).job?.phase, 'failed')
    assert.deepEqual(f.deployment.events, [])
    await new ServerUpdateManager(f.dir, trusted, f.deployment).installImage(image, 100, async () => assert.fail('must not retry'))
  }
})
test('image startup preserves a prepared administrator update', async () => {
  const f = fixture()
  const id = await prepare(f.manager)
  await f.manager.installImage(image, 100, async () => assert.fail('prepared job must be preserved'))
  assert.equal((await f.manager.status()).job?.id, id)
  assert.equal((await f.manager.status()).job?.phase, 'prepared')
})
test('image activation failure is committed and recovery must not restore old data', async () => {
  const f = fixture()
  f.deployment.failure = 'activate'
  await f.manager.installImage(image, 100, async () => {})
  assert.equal((await f.manager.status()).job?.phase, 'recoveryRequired')
  assert.ok(!f.deployment.events.includes('resume'))
  assert.equal(f.deployment.current.identity.version, image.version)
})
test('interrupted image activation resumes using the persisted image identity', async () => {
  const f = fixture()
  await f.manager.installImage(image, 100, async () => {})
  const file = path.join(f.dir, 'current.json')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...saved, phase: 'activating' }))
  f.deployment.events = []
  const restarted = new ServerUpdateManager(f.dir, trusted, f.deployment)
  await restarted.recover()
  assert.deepEqual(f.deployment.events, ['activate'])
  assert.equal((await restarted.status()).job?.phase, 'complete')
})
test('single-file offline upload resumes inner archive offsets and still requires trusted signatures', async () => {
  const f = fixture(), selected = signed()
  const file = path.join(f.dir, 'fixture.javdex-update')
  fs.writeFileSync(file, Buffer.concat([updateBundlePrefix(selected), archive]))
  let state = await f.manager.beginOffline(selected)
  state = await f.manager.upload(state.job!.id, 0, (async function* () { yield archive.subarray(0, 7) })())
  assert.equal(state.job?.receivedBytes, 7)
  assert.equal(state.job?.resumableUpload, true)
  const offsets: number[] = []
  const client = {
    import: (value: SignedServerUpdate) => f.manager.beginOffline(value),
    upload: async (id: string, offset: number, chunk: Buffer) => {
      offsets.push(offset)
      assert.deepEqual(chunk, archive.subarray(offset))
      return f.manager.upload(id, offset, (async function* () { yield chunk })())
    }
  }
  const fd = fs.openSync(file, 'r')
  try {
    const result = await uploadServerUpdateBundle(client, fd, target.version)
    assert.equal(result.job?.phase, 'prepared')
    assert.deepEqual(offsets, [7])
    assert.deepEqual(f.deployment.events, ['prepare'])
  } finally { fs.closeSync(fd) }
  const bad = fixture()
  const badFile = path.join(bad.dir, 'forged.javdex-update')
  fs.writeFileSync(badFile, Buffer.concat([updateBundlePrefix({ ...selected, signature: 'invalid' }), archive]))
  const invalid = fs.openSync(badFile, 'r')
  try {
    await assert.rejects(uploadServerUpdateBundle({ import: value => bad.manager.beginOffline(value), upload: async () => { assert.fail('Unsigned archive must never upload') } }, invalid, target.version), /签名/)
    assert.equal((await bad.manager.status()).job, null)
  } finally { fs.closeSync(invalid) }
})
async function wait(manager: ServerUpdateManager, phase: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await manager.status(false)).job?.phase === phase) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`update did not reach ${phase}`)
}
async function prepare(manager: ServerUpdateManager): Promise<string> {
  await manager.setTarget(signed())
  const snapshot = await manager.prepare()
  await wait(manager, 'prepared')
  return snapshot.job!.id
}

test('upgrade never copies the library or changes manual backup exports', async () => {
  const { manager, deployment, dir } = fixture()
  const exported = path.join(dir, 'manual.javdex-backup')
  fs.writeFileSync(exported, 'user backup')
  const id = await prepare(manager)
  await manager.install(id)
  await wait(manager, 'complete')
  assert.equal(fs.readFileSync(exported, 'utf8'), 'user backup')
  assert.deepEqual(deployment.events, ['prepare', 'stop', 'install', 'verify', 'activate'])
  assert.equal(fs.existsSync(path.join(dir, 'jobs', id, 'snapshot')), false)
  assert.equal((await new ServerUpdateManager(dir, trusted, deployment).status()).job?.phase, 'complete')
})

test('unprotected migration failure keeps maintenance and never restores older data', async () => {
  const { manager, deployment, dir } = fixture()
  const id = await prepare(manager)
  deployment.failure = 'verify'
  await manager.install(id)
  await wait(manager, 'recoveryRequired')
  assert.equal(deployment.events.includes('resume'), false)
  assert.equal(deployment.stopped, true)
  assert.match((await manager.status(false)).job!.message!, /人工恢复/)
  const restarted = new ServerUpdateManager(dir, trusted, deployment)
  await restarted.recover()
  assert.equal((await restarted.status(false)).job?.phase, 'recoveryRequired')
})

test('interrupted unprotected installation requires manual recovery after restart', async () => {
  const { manager, deployment, dir } = fixture()
  await prepare(manager)
  const file = path.join(dir, 'current.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  raw.phase = 'installing'
  fs.writeFileSync(file, JSON.stringify(raw))
  const restarted = new ServerUpdateManager(dir, trusted, deployment)
  await restarted.recover()
  assert.equal((await restarted.status(false)).job?.phase, 'recoveryRequired')
  assert.equal(deployment.events.includes('resume'), false)
})

test('requested desktop version is enforced for discovery, upload, preparation and install', async () => {
  const { manager, deployment } = fixture()
  const wrong = '0.9.0-beta.4'
  await assert.rejects(manager.setTarget(signed(), wrong), /客户端/)
  await assert.rejects(manager.beginOffline(signed(), wrong), /客户端/)
  const id = await prepare(manager)
  await assert.rejects(manager.prepare(wrong), /客户端/)
  await assert.rejects(manager.install(id, wrong), /客户端/)
  assert.equal(deployment.stopped, false)
})

test('official signature binds release, architecture and expiry; a checksum alone is insufficient', () => {
  assert.equal(verifyUpdateManifest(signed(), trusted).version, '0.8.1')
  assert.throws(() => verifyUpdateManifest({ ...signed(), payload: signed().payload.replace('0.8.1', '0.9.0') }, trusted), /签名/)
  assert.throws(() => verifyUpdateManifest(signed(), {}), /不受信任/)
  assert.throws(() => verifyUpdateManifest(signed(), trusted, Date.parse('2100-01-01')), /过期/)
  assert.throws(() => checkUpdateTarget(target, { version: '0.8.1', schema: 19, platform: 'linux/amd64' }), /更新/)
  assert.throws(() => checkUpdateTarget(target, { version: '0.8.0', schema: 22, platform: 'linux/amd64' }), /开发快照/)
  assert.throws(() => checkUpdateTarget({ ...target, sourceSchemas: [19, 20] }, { version: '0.8.0', schema: 20, platform: 'linux/amd64' }), /开发快照/)
  assert.throws(() => checkUpdateTarget(target, { version: '0.8.0', schema: 19, platform: 'linux/arm64' }), /架构/)
})
test('signed stable and beta targets follow SemVer precedence without downgrades', () => {
  const stable = { ...target, version: '0.9.0', sourceSchemas: [20], targetSchema: 20 }
  const current = { version: '0.9.0-beta.1', schema: 20, platform: 'linux/amd64', runtime: 'node22-bookworm-v1' }
  assert.doesNotThrow(() => checkUpdateTarget(stable, current))
  assert.doesNotThrow(() => checkUpdateTarget({ ...stable, version: '0.9.1' }, current))
  assert.throws(() => checkUpdateTarget({ ...stable, version: '0.8.9' }, current), /更新/)
  assert.throws(() => checkUpdateTarget(stable, { ...current, version: '0.9.0' }), /更新/)
  assert.throws(() => checkUpdateTarget(stable, { ...current, version: 'unknown' }), /更新/)
  assert.throws(() => checkUpdateTarget({ ...stable, sourceSchemas: [19] }, current), /升级路径/)
  assert.throws(() => checkUpdateTarget(stable, { ...current, platform: 'linux/arm64' }), /架构/)
  assert.equal(verifyUpdateManifest(signed({ ...stable, version: '0.9.0-beta.2' }), trusted).version, '0.9.0-beta.2')
  for (const [source, destination] of [
    ['0.8.0', '0.9.0-beta.1'], ['0.9.0-beta.1', '0.9.0-beta.2'],
    ['0.9.0-beta.2', '0.9.0-beta.10'], ['0.9.0-beta.10', '0.9.0-rc.1'],
    ['0.9.0-rc.1', '0.9.0']
  ]) assert.doesNotThrow(() => checkUpdateTarget({ ...stable, version: destination, sourceSchemas: [19, 20] }, { ...current, version: source, schema: source === '0.8.0' ? 19 : 20 }))
  for (const [source, destination] of [
    ['0.9.0-beta.10', '0.9.0-beta.2'], ['0.9.0', '0.9.0-beta.10'],
    ['0.9.0-beta.2', '0.9.0-beta.2'], ['0.9.0-beta.2', '0.8.9']
  ]) assert.throws(() => checkUpdateTarget({ ...stable, version: destination }, { ...current, version: source }), /更新/)
  for (const invalid of ['0.9.0-beta.01', '0.09.0-beta.1', '0.9.0-beta..1', '0.9.0+build']) {
    assert.throws(() => verifyUpdateManifest(signed({ ...stable, version: invalid }), trusted))
  }
})
test('an explicitly uploaded signed beta upgrades a beta and preserves the installation safeguards', async () => {
  const { manager, deployment } = fixture()
  deployment.current.identity.version = '0.9.0-beta.2'
  deployment.current.identity.schema = 20
  deployment.current.release = `0.9.0-beta.2-${'d'.repeat(64)}`
  const before = await deployment.inspect()
  const manifest = { ...target, version: '0.9.0-beta.10', sourceSchemas: [20] }
  const initial = await manager.beginOffline(signed(manifest))
  const id = initial.job!.id
  assert.equal((await manager.upload(id, 0, (async function* () { yield archive })())).job?.phase, 'prepared')
  assert.equal(deployment.stopped, false)
  await manager.install(id)
  await wait(manager, 'complete')
  const after = await manager.status()
  assert.equal(after.currentVersion, '0.9.0-beta.10')
  assert.equal(after.serverId, before.identity.serverId)
  assert.equal(after.catalogId, before.identity.catalogId)
  assert.deepEqual(deployment.events, ['prepare', 'stop', 'install', 'verify', 'activate'])
  await assert.rejects(manager.beginOffline(signed({ ...manifest, version: '0.9.0-beta.2' })), /更新/)
})
test('user-confirmed installation preserves identity and commits before business activation', async () => {
  const { manager, deployment } = fixture()
  const before = await deployment.inspect()
  const id = await prepare(manager)
  assert.equal(deployment.stopped, false)
  await manager.install(id)
  await manager.install(id)
  await wait(manager, 'complete')
  const result = await manager.status()
  assert.equal(result.serverId, before.identity.serverId)
  assert.equal(result.catalogId, before.identity.catalogId)
  assert.equal(result.currentVersion, '0.8.1')
  assert.equal(result.targetVersion, null)
  assert.equal((await manager.setTarget(signed())).targetVersion, null)
  assert.deepEqual(deployment.events, ['prepare', 'stop', 'install', 'verify', 'activate'])
})
test('new maintenance tasks block installation even after release preparation', async () => {
  const { manager, deployment } = fixture()
  const id = await prepare(manager)
  deployment.current.identity.busy = true
  await assert.rejects(manager.install(id), /维护任务/)
  assert.equal(deployment.stopped, false)
})
test('cleanup trouble after business activation cannot roll back the installed version', async () => {
  const { manager, deployment, dir } = fixture()
  const id = await prepare(manager)
  const old = path.join(dir, 'jobs', randomUUID())
  fs.mkdirSync(old)
  fs.writeFileSync(path.join(old, 'job.json'), 'interrupted metadata')
  await manager.install(id)
  await wait(manager, 'complete')
  assert.equal(deployment.current.identity.schema, 20)
  assert.equal(deployment.events.includes('resume'), false)
  assert.match((await manager.status()).job!.message!, /清理未完成/)
  assert.ok(fs.existsSync(old))
})
test('stop failure resumes unchanged original service without restoring data', async () => {
  const { manager, deployment } = fixture()
  const id = await prepare(manager)
  deployment.stop = async () => { throw new Error('stop interrupted') }
  await manager.install(id)
  await wait(manager, 'failed')
  assert.equal(deployment.current.identity.schema, 19)
  assert.ok(deployment.events.includes('resume'))
})

test('activation uncertainty never restarts old software over possible new writes', async () => {
  const { manager, deployment } = fixture()
  const id = await prepare(manager)
  deployment.failure = 'activate'
  await manager.install(id)
  await wait(manager, 'recoveryRequired')
  assert.equal(deployment.current.identity.schema, 20)
  assert.equal(deployment.events.includes('resume'), false)
})
test('failed recovery remains blocked and cannot accept another update', async () => {
  const { manager, deployment, dir } = fixture()
  const id = await prepare(manager)
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8')) as Record<string, unknown>
  raw.phase = 'stopping'
  fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(raw))
  deployment.failure = 'resume'
  const restarted = new ServerUpdateManager(dir, trusted, deployment)
  await restarted.recover()
  assert.equal((await restarted.status(false)).job?.id, id)
  assert.equal((await restarted.status(false)).job?.phase, 'recoveryRequired')
  await assert.rejects(restarted.setTarget(signed()), /人工恢复/)
})
test('restart blocks interrupted installation but completes a durable activation', async () => {
  for (const phase of ['verifying', 'activating']) {
    const { manager, deployment, dir } = fixture()
    await prepare(manager)
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8')) as Record<string, unknown>
    raw.phase = phase
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(raw))
    await deployment.install(target)
    const restarted = new ServerUpdateManager(dir, trusted, deployment)
    await restarted.recover()
    assert.equal((await restarted.status(false)).job?.phase, phase === 'verifying' ? 'recoveryRequired' : 'complete')
    assert.equal(deployment.events.includes('resume'), false)
  }
})
test('offline upload resumes at durable offset after helper restart and validates complete bytes before loading', async () => {
  const { manager, deployment, dir } = fixture()
  const first = await manager.beginOffline(signed())
  const id = first.job!.id
  async function* chunk(value: Buffer): AsyncGenerator<Buffer> { yield value }
  await manager.upload(id, 0, chunk(archive.subarray(0, 10)))
  await assert.rejects(manager.upload(id, 0, chunk(archive)), /偏移/)
  const restarted = new ServerUpdateManager(dir, trusted, deployment)
  const resumed = await restarted.beginOffline(signed())
  assert.equal(resumed.job?.id, id)
  assert.equal(resumed.job?.receivedBytes, 10)
  await restarted.upload(id, 10, chunk(archive.subarray(10)))
  assert.equal((await restarted.status(false)).job?.phase, 'prepared')
  assert.deepEqual(deployment.events, ['prepare'])
  assert.equal((await restarted.beginOffline(signed())).job?.id, id)
})
test('tampered offline content is rejected before release unpacking', async () => {
  const { manager, deployment } = fixture()
  const state = await manager.beginOffline(signed())
  async function* corrupted(): AsyncGenerator<Buffer> { yield Buffer.alloc(archive.length) }
  await assert.rejects(manager.upload(state.job!.id, 0, corrupted()), /校验失败/)
  assert.equal(deployment.events.length, 0)
  assert.equal(deployment.stopped, false)
})

test('a manager restart after the last durable upload chunk completes release preparation', async () => {
  const { manager, deployment, dir } = fixture()
  const state = await manager.beginOffline(signed())
  fs.writeFileSync(path.join(dir, 'jobs', state.job!.id, 'release.tar.gz'), archive)
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8')) as Record<string, unknown>
  saved.receivedBytes = archive.length
  fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(saved))
  const restarted = new ServerUpdateManager(dir, trusted, deployment)
  await restarted.recover()
  assert.equal((await restarted.status(false)).job?.phase, 'prepared')
  assert.deepEqual(deployment.events, ['prepare'])
})

test('cleanup journal write failure cannot discard an acknowledged upload chunk', async () => {
  const { manager, deployment, dir } = fixture()
  const state = await manager.beginOffline(signed())
  const id = state.job!.id
  const rename = fs.renameSync
  const injected = mock.method(fs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination) === path.join(dir, 'jobs', id, 'job.json')) throw new Error('archive journal unavailable')
    return rename(source, destination)
  })
  try {
    assert.equal((await manager.upload(id, 0, (async function* () { yield archive.subarray(0, 10) })())).job?.receivedBytes, 10)
    const restarted = new ServerUpdateManager(dir, trusted, deployment)
    assert.equal((await restarted.status(false)).job?.receivedBytes, 10)
    assert.equal(fs.statSync(path.join(dir, 'jobs', id, 'release.tar.gz')).size, 10)
  } finally { injected.mock.restore() }
})

test('failed authoritative upload journal keeps the last durable offset in memory and on restart', async () => {
  const { manager, deployment, dir } = fixture()
  const state = await manager.beginOffline(signed())
  const id = state.job!.id
  const rename = fs.renameSync
  const injected = mock.method(fs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination) === path.join(dir, 'current.json')) throw new Error('current journal unavailable')
    return rename(source, destination)
  })
  try {
    await assert.rejects(manager.upload(id, 0, (async function* () { yield archive.subarray(0, 10) })()), /journal unavailable/)
    assert.equal((await manager.status(false)).job?.receivedBytes, 0)
    assert.equal(fs.statSync(path.join(dir, 'jobs', id, 'release.tar.gz')).size, 0)
    assert.equal((await new ServerUpdateManager(dir, trusted, deployment).status(false)).job?.receivedBytes, 0)
  } finally { injected.mock.restore() }
  assert.equal((await manager.upload(id, 0, (async function* () { yield archive })())).job?.phase, 'prepared')
})

for (const afterRename of [false, true]) test(`commit journal failure ${afterRename ? 'after' : 'before'} rename respects the durable rollback boundary`, async () => {
  const { manager, deployment, dir } = fixture()
  const id = await prepare(manager)
  const rename = fs.renameSync
  let failed = false
  const injected = mock.method(fs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
    if (!failed && String(destination) === path.join(dir, 'current.json') && JSON.parse(fs.readFileSync(source, 'utf8')).phase === 'activating') {
      failed = true
      if (afterRename) rename(source, destination)
      throw new Error('injected commit write failure')
    }
    return rename(source, destination)
  })
  try {
    await manager.install(id)
    await wait(manager, 'recoveryRequired')
    assert.equal(failed, true)
    assert.equal(deployment.events.includes('activate'), false)
    assert.equal(deployment.events.includes('resume'), false)
    assert.equal(deployment.current.identity.schema, 20)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8')).phase, 'recoveryRequired')
  } finally { injected.mock.restore() }
})

test('retrying a fully received upload continues preparation after an uncertain last-chunk acknowledgement', async () => {
  const { manager, deployment, dir } = fixture()
  const state = await manager.beginOffline(signed())
  const id = state.job!.id
  const rename = fs.renameSync
  let failed = false
  const injected = mock.method(fs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
    if (!failed && String(destination) === path.join(dir, 'current.json') && JSON.parse(fs.readFileSync(source, 'utf8')).receivedBytes === archive.length) {
      failed = true
      rename(source, destination)
      throw new Error('uncertain last acknowledgement')
    }
    return rename(source, destination)
  })
  try {
    await assert.rejects(manager.upload(id, 0, (async function* () { yield archive })()), /last acknowledgement/)
    assert.equal((await manager.status(false)).job?.receivedBytes, archive.length)
    assert.equal(deployment.events.length, 0)
  } finally { injected.mock.restore() }
  assert.equal((await manager.beginOffline(signed())).job?.phase, 'prepared')
  assert.deepEqual(deployment.events, ['prepare'])
})

test('manager serializes prepare and target changes before the asynchronous deployment inspection', async () => {
  const { manager, deployment, dir } = fixture()
  await manager.setTarget(signed())
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const inspect = deployment.inspect.bind(deployment)
  deployment.inspect = async () => { await gate; return inspect() }
  const first = manager.prepare()
  try {
    await assert.rejects(manager.prepare(), /请求正在处理/)
    await assert.rejects(manager.setTarget(signed({ ...target, version: '0.9.0-beta.1' })), /请求正在处理/)
  } finally { release() }
  await first
  await wait(manager, 'prepared')
  const job = JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8'))
  assert.equal(job.version, JSON.parse(job.signed.payload).version)
  assert.equal(fs.readdirSync(path.join(dir, 'jobs')).length, 1)
  assert.deepEqual(deployment.events, ['prepare'])
})

test('manager prevents duplicate install preflights and stops the business only once', async () => {
  const { manager, deployment } = fixture()
  const id = await prepare(manager)
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const inspect = deployment.inspect.bind(deployment)
  deployment.inspect = async () => { await gate; return inspect() }
  const first = manager.install(id)
  try { await assert.rejects(manager.install(id), /请求正在处理/) }
  finally { release() }
  await first
  await wait(manager, 'complete')
  assert.equal(deployment.events.filter(event => event === 'stop').length, 1)
})
