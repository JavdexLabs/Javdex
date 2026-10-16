import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { c } from 'tar'
import { ReleaseStore, releaseId, releasePath } from './releaseStore'
import { fixture, makeRelease, archiveRelease } from './testFixtures'

test('image preparation validates content and native closure without selecting it', async () => {
  const { root, config } = await fixture()
  try {
    const store = new ReleaseStore(config)
    await store.bootstrap()
    const original = store.current()
    makeRelease(config.seedDir, '0.8.1')
    const image = store.imageRelease()
    await store.prepareImage(image.release)
    await store.verifyInstalled(releaseId(image.release))
    assert.equal(store.current(), original)
    makeRelease(config.seedDir, '0.8.2')
    await assert.rejects(store.prepareImage(image.release), /已变化/)
    const corrupt = store.imageRelease()
    fs.writeFileSync(path.join(config.seedDir, 'index.js'), 'corrupt')
    await assert.rejects(store.prepareImage(corrupt.release), /损坏/)
    assert.equal(store.current(), original)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('seed is installed once; persistent active release survives a rebuilt image and tampering is rejected', async () => {
  const { root, config } = await fixture()
  try {
    const store = new ReleaseStore(config)
    await store.bootstrap()
    const original = store.current()
    makeRelease(config.seedDir, '0.8.2')
    await store.bootstrap()
    assert.equal(store.current(), original)
    fs.writeFileSync(path.join(store.directory(original!), 'index.js'), 'tampered')
    await assert.rejects(store.bootstrap(), /损坏/)
    assert.equal(store.current(), original)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
test('published program descriptors remain readable without inventing an environment version', async () => {
  const { root, config } = await fixture()
  try {
    const file = path.join(config.seedDir, 'release.json')
    const legacy = JSON.parse(fs.readFileSync(file, 'utf8'))
    delete legacy.environmentVersion
    fs.writeFileSync(file, JSON.stringify(legacy))
    const store = new ReleaseStore(config)
    await store.bootstrap()
    assert.equal(store.descriptor(store.directory(store.current()!)).environmentVersion, undefined)
    await store.verifyInstalled(store.current()!)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), legacy)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
test('complete release archive is verified and staged without switching the running version', async () => {
  const { root, config } = await fixture()
  try {
    const store = new ReleaseStore(config)
    await store.bootstrap()
    const original = store.current()
    const source = path.join(root, 'next')
    makeRelease(source, '0.8.1')
    const archive = path.join(root, 'next.tar.gz')
    const manifest = await archiveRelease(source, archive)
    await store.prepare(manifest, archive)
    await store.prepare(manifest, archive)
    assert.equal(store.current(), original)
    assert.equal((await store.verify(store.directory(releaseId(manifest)))).version, '0.8.1')
    assert.equal(fs.statSync(path.join(store.directory(releaseId(manifest)), 'index.js')).mode & 0o777, 0o644)
    await assert.rejects(store.prepare({ ...manifest, platform: manifest.platform === 'linux/amd64' ? 'linux/arm64' : 'linux/amd64' }, archive), /运行环境/)
    await assert.rejects(store.prepare({ ...manifest, archive: { ...manifest.archive, sha256: '0'.repeat(64) } }, archive), /校验/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
test('archive links, repeated files, oversized expansion and mismatched file sets fail before activation', async () => {
  const { root, config } = await fixture()
  try {
    const store = new ReleaseStore(config)
    await store.bootstrap()
    const original = store.current()
    const source = path.join(root, 'next')
    makeRelease(source, '0.8.1')
    fs.symlinkSync('/tmp', path.join(source, 'escape'))
    for (const names of [['escape'], ['index.js', 'index.js']]) {
      const file = path.join(root, 'bad.tar.gz')
      await c({ file, cwd: source, gzip: true, portable: true }, names)
      const base = await archiveRelease(source, path.join(root, 'safe.tar.gz'))
      const manifest = { ...base, archive: { ...base.archive, bytes: fs.statSync(file).size, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') } }
      await assert.rejects(store.prepare(manifest, file), /不安全|重复|链接/)
    }
    const file = path.join(root, 'safe.tar.gz')
    const manifest = await archiveRelease(source, file)
    await assert.rejects(store.prepare({ ...manifest, archive: { ...manifest.archive, unpackedBytes: 1 } }, file), /限制/)
    const contents = fs.readFileSync(path.join(source, 'index.js'), 'utf8')
    fs.writeFileSync(path.join(source, 'index.js'), ` ${contents.slice(1)}`)
    const changed = await archiveRelease(source, file)
    await assert.rejects(store.prepare(changed, file), /损坏/)
    assert.equal(store.current(), original)
    for (const value of ['../x', '/x', 'a/../x', 'C:/x', 'a\\x', 'a//x']) assert.equal(releasePath(value), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
