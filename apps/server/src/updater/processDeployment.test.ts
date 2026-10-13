import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { ReleaseStore, releaseId } from './releaseStore'
import { BusinessSupervisor } from './supervisor'
import { ProcessUpdateDeployment } from './processDeployment'
import { MANAGED_LOCK } from './storage'
import { fixture, makeRelease, archiveRelease } from './testFixtures'

for (const badWorker of [false, true]) test(`synthetic host lifecycle: ${badWorker ? 'migration failure restores' : 'verified activation preserves'} data and persistent release`, async () => {
  const { root, config } = await fixture()
  const supervisor = new BusinessSupervisor(config)
  try {
    const store = new ReleaseStore(config)
    await store.bootstrap()
    const deployment = new ProcessUpdateDeployment(config, store, supervisor, { readyTimeoutMs: 3000, probe: async () => JSON.parse(fs.readFileSync(path.join(config.dataDir, 'catalog.fixture.json'), 'utf8')) })
    await deployment.startCurrent()
    const original = await deployment.inspect({ measure: true })
    fs.writeFileSync(path.join(config.dataDir, 'user-bytes'), 'user data preserved')
    fs.writeFileSync(path.join(config.dataDir, MANAGED_LOCK), 'locked inode preserved')
    const inode = fs.statSync(path.join(config.dataDir, MANAGED_LOCK)).ino
    const job = path.join(config.stateDir, randomUUID())
    fs.mkdirSync(job)
    const next = path.join(root, 'next')
    makeRelease(next, '0.8.1', badWorker)
    const archive = path.join(root, 'next.tar.gz')
    const manifest = await archiveRelease(next, archive)
    await deployment.prepare(manifest, archive)
    assert.equal(supervisor.running, true)
    await deployment.stop()
    await deployment.backup(job, original)
    await deployment.install(manifest, randomUUID(), original)
    if (badWorker) {
      await assert.rejects(deployment.verify(manifest, original), /启动/)
      await deployment.restore(job, original)
      assert.equal((await deployment.inspect()).identity.schema, 19)
      assert.equal(store.current(), original.release)
    } else {
      await deployment.verify(manifest, original)
      assert.equal((await fetch(`${config.serverUrl}/manage/v1/handshake.get`)).status, 503)
      const guard = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'server-update-guard.json'), 'utf8')) as { id: string }
      const databaseFile = path.join(config.dataDir, 'catalog.fixture.json')
      const database = fs.readFileSync(databaseFile, 'utf8')
      fs.writeFileSync(databaseFile, JSON.stringify({ ...JSON.parse(database), serverId: randomUUID() }))
      await assert.rejects(deployment.activate(guard.id, manifest, original), /身份/)
      assert.equal((await fetch(`${config.serverUrl}/manage/v1/handshake.get`)).status, 503)
      fs.writeFileSync(databaseFile, database)
      await deployment.activate(guard.id, manifest, original)
      assert.equal(store.current(), releaseId(manifest))
      assert.equal((await fetch(`${config.serverUrl}/manage/v1/handshake.get`)).status, 200)
    }
    assert.equal(fs.statSync(path.join(config.dataDir, MANAGED_LOCK)).ino, inode)
    assert.equal(fs.readFileSync(path.join(config.dataDir, 'user-bytes'), 'utf8'), 'user data preserved')
    assert.equal((await deployment.inspect()).identity.serverId, original.identity.serverId)
  } finally { await supervisor.shutdown(); fs.rmSync(root, { recursive: true, force: true }) }
})
test('incomplete snapshot resumes unchanged original data; changed configuration fails before stopping', async () => {
  const { root, config } = await fixture()
  const supervisor = new BusinessSupervisor(config)
  try {
    const store = new ReleaseStore(config)
    await store.bootstrap()
    const deployment = new ProcessUpdateDeployment(config, store, supervisor, { readyTimeoutMs: 3000, probe: async () => JSON.parse(fs.readFileSync(path.join(config.dataDir, 'catalog.fixture.json'), 'utf8')) })
    await deployment.startCurrent()
    const original = await deployment.inspect()
    const job = path.join(config.stateDir, 'incomplete')
    fs.mkdirSync(job)
    await deployment.stop()
    fs.writeFileSync(path.join(config.dataDir, 'preserved'), 'no replacement')
    await deployment.restore(job, original)
    assert.equal(fs.readFileSync(path.join(config.dataDir, 'preserved'), 'utf8'), 'no replacement')
    fs.appendFileSync(config.serverConfigPath, '\n')
    await assert.rejects(deployment.inspect(), /配置已变化/)
    assert.equal(supervisor.running, true)
  } finally { await supervisor.shutdown(); fs.rmSync(root, { recursive: true, force: true }) }
})
test('corrupted snapshot is rejected without deleting current data', async () => {
  const { root, config } = await fixture()
  const supervisor = new BusinessSupervisor(config)
  try {
    const store = new ReleaseStore(config)
    await store.bootstrap()
    const deployment = new ProcessUpdateDeployment(config, store, supervisor, { probe: async () => JSON.parse(fs.readFileSync(path.join(config.dataDir, 'catalog.fixture.json'), 'utf8')) })
    fs.writeFileSync(path.join(config.dataDir, 'user-bytes'), 'original')
    const original = await deployment.inspect()
    const job = path.join(config.stateDir, 'snapshot-test')
    fs.mkdirSync(job)
    await deployment.backup(job, original)
    fs.writeFileSync(path.join(job, 'snapshot', 'root-0', 'user-bytes'), 'corrupted')
    fs.writeFileSync(path.join(config.dataDir, 'user-bytes'), 'current data')
    await assert.rejects(deployment.restore(job, original), /快照内容损坏/)
    assert.equal(fs.readFileSync(path.join(config.dataDir, 'user-bytes'), 'utf8'), 'current data')
  } finally { await supervisor.shutdown(); fs.rmSync(root, { recursive: true, force: true }) }
})
test('unexpected business exit is supervised; planned stop never races a scheduled restart', async () => {
  const { root, config } = await fixture()
  const supervisor = new BusinessSupervisor(config)
  try {
    const store = new ReleaseStore(config)
    await store.bootstrap()
    const deployment = new ProcessUpdateDeployment(config, store, supervisor, { readyTimeoutMs: 3000 })
    await deployment.startCurrent()
    const pid = supervisor.pid!
    process.kill(pid, 'SIGKILL')
    for (let i = 0; i < 120; i++) {
      if (supervisor.pid && supervisor.pid !== pid) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(supervisor.pid && supervisor.pid !== pid)
    await deployment.stop()
    await new Promise(resolve => setTimeout(resolve, 1200))
    assert.equal(supervisor.running, false)
    assert.equal(supervisor.pid, null)
  } finally { await supervisor.shutdown(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('invalid independent image tree is detected before replacing either data root', async () => {
  const { root, config } = await fixture({ independentImages: true })
  const supervisor = new BusinessSupervisor(config)
  try {
    const store = new ReleaseStore(config)
    await store.bootstrap()
    const deployment = new ProcessUpdateDeployment(config, store, supervisor, { probe: async () => JSON.parse(fs.readFileSync(path.join(config.dataDir, 'catalog.fixture.json'), 'utf8')) })
    const file = path.join(config.dataDir, 'user-bytes')
    fs.writeFileSync(file, 'original')
    const original = await deployment.inspect()
    const job = path.join(config.stateDir, 'independent-snapshot')
    fs.mkdirSync(job)
    await deployment.backup(job, original)
    fs.writeFileSync(file, 'current must survive validation failure')
    const invalid = path.join(config.imagesDir, 'invalid-link')
    fs.symlinkSync(file, invalid)
    await assert.rejects(deployment.restore(job, original), /链接或特殊文件/)
    assert.equal(fs.readFileSync(file, 'utf8'), 'current must survive validation failure')
    fs.unlinkSync(invalid)
    fs.writeFileSync(path.join(job, 'snapshot', 'server-config.json'), 'corrupt configuration')
    await assert.rejects(deployment.restore(job, original), /快照配置损坏/)
    assert.equal(fs.readFileSync(file, 'utf8'), 'current must survive validation failure')
  } finally { await supervisor.shutdown(); fs.rmSync(root, { recursive: true, force: true }) }
})
