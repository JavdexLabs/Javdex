import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { packageRelease } from './server-release-package.mjs'
import { keyDirectoryOutsideRepository, releaseSigning, signedReleaseManifest } from './server-update-release.mjs'
import { verifyUpdateManifest } from '../apps/server/src/updater/manifest.ts'

const keys = generateKeyPairSync('ed25519') // Ephemeral test key, never a release credential.
const env = {
  JAVDEX_SERVER_UPDATE_KEY_ID: 'test',
  JAVDEX_SERVER_UPDATE_SIGNING_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
}

test('key storage rejects repository children including dot-prefixes and external symlink aliases', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-key-path-'))
  try {
    const repository = path.join(root, 'repository')
    fs.mkdirSync(repository)
    for (const directory of [repository, path.join(repository, 'keys'), path.join(repository, '..keys')]) {
      assert.throws(() => keyDirectoryOutsideRepository(directory, repository), /outside the repository/)
    }
    const alias = path.join(root, 'alias')
    fs.symlinkSync(repository, alias, 'junction')
    assert.throws(() => keyDirectoryOutsideRepository(path.join(alias, 'keys'), repository), /outside the repository/)
    assert.equal(keyDirectoryOutsideRepository(path.join(root, 'private', 'keys'), repository), path.join(fs.realpathSync(root), 'private', 'keys'))
    assert.throws(() => keyDirectoryOutsideRepository(path.resolve('..keys')), /outside the repository/)
    assert.deepEqual(fs.readdirSync(repository), [])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('stable and prerelease publication requires a canonical version and an Ed25519 private key', () => {
  for (const version of ['0.9.0', '0.9.0-beta.1', '0.9.0-beta.10', '0.9.0-rc.1']) {
    assert.equal(releaseSigning(version, env).publicKey, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString())
    assert.throws(() => releaseSigning(version, {}), /Configure/)
  }
  for (const version of ['v0.9.0', '0.9.0-beta.01', '0.09.0', '0.9.0+build', '0.9.0\n', '../0.9.0']) assert.throws(() => releaseSigning(version, env), /version/)
  assert.throws(() => releaseSigning('0.9.0-beta.1', { ...env, JAVDEX_SERVER_UPDATE_KEY_ID: '../key' }), /Configure/)
  assert.throws(() => releaseSigning('0.9.0-beta.1', { ...env, JAVDEX_SERVER_UPDATE_SIGNING_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }), /private key/)
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
  assert.throws(() => releaseSigning('0.9.0-beta.1', { ...env, JAVDEX_SERVER_UPDATE_SIGNING_KEY: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }), /Ed25519/)
})

test('publication preflight CLI fails without a key and validates a beta without writing credentials or artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-signing-preflight-'))
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.9.0-beta.1' }))
    const script = path.resolve('scripts/server-update-release.mjs')
    const missing = spawnSync(process.execPath, [script, 'validate'], { cwd: root, env: { ...process.env, JAVDEX_SERVER_UPDATE_SIGNING_KEY: '', JAVDEX_SERVER_UPDATE_KEY_ID: '' }, encoding: 'utf8' })
    assert.notEqual(missing.status, 0)
    const valid = spawnSync(process.execPath, [script, 'validate'], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' })
    assert.equal(valid.status, 0, valid.stderr)
    assert.match(valid.stdout, /0\.9\.0-beta\.1/)
    assert.equal(valid.stdout.includes(env.JAVDEX_SERVER_UPDATE_SIGNING_KEY), false)
    assert.deepEqual(fs.readdirSync(root), ['package.json'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

for (const platform of ['linux/amd64', 'linux/arm64']) test(`beta ${platform} archive and signed manifest bind the real packaged bytes`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-beta-release-'))
  try {
    const source = path.join(root, 'closure')
    const version = '0.9.0-beta.1'
    const files = {
      'package.json': JSON.stringify({ version }),
      'build-info.json': JSON.stringify({ format: 1, build: 'a'.repeat(40), targetSchema: 20 }),
      'index.js': '// synthetic publisher fixture', 'webCatalogWorker.js': '// synthetic worker',
      'web/index.html': '<title>fixture</title>', LICENSE: 'fixture', NOTICE: 'fixture',
      'node_modules/better-sqlite3/package.json': '{}', 'node_modules/sharp/package.json': '{}'
    }
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(source, name)
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content)
    }
    const arch = platform.split('/')[1]
    const name = `Javdex-server-${version}-linux-${arch}.tar.gz`
    const archive = path.join(root, name)
    const packaged = await packageRelease(source, archive, platform)
    const signer = releaseSigning(version, env)
    const signed = signedReleaseManifest(packaged, signer, 0)
    assert.ok(verify(null, Buffer.from(signed.payload), keys.publicKey, Buffer.from(signed.signature, 'base64')))
    const manifest = verifyUpdateManifest(signed, { test: signer.publicKey }, 0)
    assert.equal(manifest.version, version)
    assert.equal(manifest.platform, platform)
    assert.equal(manifest.archive.bytes, fs.statSync(archive).size)
    assert.equal(manifest.archive.unpackedBytes, packaged.unpackedBytes)
    assert.equal(manifest.archive.sha256, createHash('sha256').update(fs.readFileSync(archive)).digest('hex'))
    assert.equal(manifest.archive.url, `https://github.com/JavdexLabs/Javdex/releases/download/v${version}/${name}`)
    assert.deepEqual(manifest.sourceSchemas, [19, 20])
    assert.equal(manifest.targetSchema, 20)
    assert.equal(manifest.runtime, 'node22-bookworm-v1')
    assert.equal(verify(null, Buffer.from(signed.payload.replace(version, '0.9.0-beta.2')), keys.publicKey, Buffer.from(signed.signature, 'base64')), false)
    assert.equal(Object.keys(packaged.descriptor.files).some(file => file.includes('private.pem')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
