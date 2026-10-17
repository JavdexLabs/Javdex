import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createDesktopRuntime } from '../apps/desktop/src/main/bootstrap/createDesktopRuntime'
import { createThisComputerSettingsStore, thisComputerSettingsPath } from '../apps/desktop/src/main/desktop/thisComputerSettingsStore'
import { createServerConnectionStore } from '../apps/desktop/src/main/desktop/serverConnectionStore'
import { createWriterCredentialStore } from '../apps/desktop/src/main/desktop/writerCredentialStore'

test('the actual desktop runtime reopens the same unified HTTPS authorization without opening a local catalog', async () => {
  const root = process.env.JAVDEX_FIXTURE_REMOTE_PROFILE!
  assert.equal(path.basename(root), 'client-profile')
  assert.ok(path.basename(path.dirname(root)).startsWith('javdex-playback-acceptance-server-startup-'))
  const pairing = JSON.parse(process.env.JAVDEX_FIXTURE_REMOTE_PAIRING!)
  const version = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version as string
  const store = createServerConnectionStore(root, { assertAvailable() {}, encrypt: value => Buffer.from(value), decrypt: value => value.toString() })
  const credentials = createWriterCredentialStore({ userDataPath: root, cipher: { isAvailable: () => true,
    encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() } })
  await credentials.writeWriterSecret(pairing.catalogId, pairing.token)
  store.write(pairing)
  const initial = fs.readFileSync(path.join(root, 'writer-secrets.json'))
  await createThisComputerSettingsStore(thisComputerSettingsPath(root)).write({ mode: 'remote', remoteBaseUrl: pairing.url,
    playerPreference: 'builtin', resumePlayback: false })
  for (let attempt = 0; attempt < 2; attempt++) {
    const runtime = await createDesktopRuntime(root, version, { credentials, connectionStore: store,
      verifyCertificate: async fingerprint => { assert.equal(fingerprint, pairing.certificateSha256) },
      detectDefaultPlayer: async () => ({ status: 'unavailable', message: 'isolated fixture' }) })
    try {
      assert.equal(runtime.openedCatalog, false)
      assert.equal(runtime.backend.session().state, 'available')
      assert.equal(runtime.backend.session().mode, 'remote')
      const devices = await runtime.backend.devices!.list()
      assert.equal(devices.length, 1); assert.equal(devices[0].current, true)
      assert.equal(fs.existsSync(path.join(root, 'data/library.db')), false)
    } finally { await runtime.dispose() }
  }
  const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex')
  assert.equal(digest(fs.readFileSync(path.join(root, 'writer-secrets.json'))), digest(initial), 'restart must reuse the same credential bytes')
})
