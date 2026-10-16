import assert from 'node:assert/strict'
import { test } from 'node:test'
import { discoverUpgrade } from './upgradeDiscovery'
import { serverUpdateCommandSchema, type ServerUpdateManifest } from '@shared/serverUpdateTypes'
import { SERVER_ENVIRONMENT_VERSION } from '@shared/serverEnvironment'

const version = '0.9.0-beta.4'
const url = `https://github.com/JavdexLabs/Javdex/releases/download/v${version}/Javdex-server-${version}-linux-amd64.javdex-update`
const release = { tag_name: `v${version}`, draft: false, prerelease: true, assets: [{ name: `Javdex-server-${version}-linux-amd64.javdex-update`, browser_download_url: url }] }
const manifest: ServerUpdateManifest = { format: 1, version, build: 'a'.repeat(40), expiresAt: '2099-01-01T00:00:00.000Z', platform: 'linux/amd64', sourceSchemas: [21], targetSchema: 21, minUpdaterProtocol: 1, runtime: 'node22-bookworm-v1', environmentVersion: SERVER_ENVIRONMENT_VERSION, archive: { url, bytes: 123, unpackedBytes: 456, sha256: 'b'.repeat(64) } }
const signed = { keyId: 'test', payload: JSON.stringify(manifest), signature: 'signature-is-verified-by-manager' }

test('recovery commands require a target and reject the removed upgrade-backup option', () => {
  const jobId = '33333333-3333-4333-8333-333333333333'
  for (const action of ['check', 'prepare', 'import', 'install']) {
    const command = { action, ...(action === 'install' ? { jobId } : {}) }
    assert.equal(serverUpdateCommandSchema.safeParse(command).success, false)
    assert.equal(serverUpdateCommandSchema.safeParse({ ...command, targetVersion: version }).success, true)
  }
  assert.equal(serverUpdateCommandSchema.safeParse({ action: 'install', jobId, targetVersion: version, backupBeforeUpgrade: true }).success, false)
})

test('recovery discovers the exact desktop tag, including prerelease, rather than latest', async () => {
  const requests: string[] = []
  const result = await discoverUpgrade('linux/amd64', version, async source => { requests.push(source); return release }, async source => { requests.push(source.href); return signed })
  assert.equal(result.payload, signed.payload)
  assert.deepEqual(requests, [`https://api.github.com/repos/JavdexLabs/Javdex/releases/tags/v${version}`, url])
})

test('missing or draft exact tag and unavailable architecture never fall back to another release', async () => {
  for (const selected of [{ ...release, tag_name: 'v0.9.1' }, { ...release, draft: true }, { ...release, assets: [] }]) {
    await assert.rejects(discoverUpgrade('linux/amd64', version, async () => selected, async () => assert.fail('must not download')))
  }
  await assert.rejects(discoverUpgrade('linux/arm64', version, async () => release, async () => assert.fail('must not download')), /架构/)
})

test('discovery rejects untrusted download sources and mismatched payload version', async () => {
  for (const source of ['https://example.com/update', 'http://github.com/JavdexLabs/Javdex/releases/download/x', 'https://github.com/another/repo/releases/download/x']) {
    await assert.rejects(discoverUpgrade('linux/amd64', version, async () => ({ ...release, assets: [{ ...release.assets[0], browser_download_url: source }] }), async () => assert.fail('must not download')), /来源/)
  }
  await assert.rejects(discoverUpgrade('linux/amd64', version, async () => release, async () => ({ ...signed, payload: JSON.stringify({ ...manifest, version: '0.9.1' }) })), /版本不一致/)
})
