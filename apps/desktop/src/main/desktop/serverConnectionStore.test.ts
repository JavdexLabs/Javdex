import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, it } from 'node:test'
import { createServerConnectionStore } from './serverConnectionStore'
import { serverUpdateCommandSchema } from '@shared/serverUpdateTypes'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const pairing = {
  protocolVersion: 1, url: 'https://example.test/', certificateSha256: 'a'.repeat(64), token: 'b'.repeat(64),
  serverId: '11111111-1111-4111-8111-111111111111', catalogId: '22222222-2222-4222-8222-222222222222'
}
function fixture(kind?: 'device') {
  const root = mkdtempSync(path.join(tmpdir(), 'javdex-connection-'))
  roots.push(root)
  const file = path.join(root, 'server-update-secrets.bin')
  writeFileSync(file, JSON.stringify({ pairing, remoteBaseUrl: 'https://example.test', credentialKind: kind }))
  const store = createServerConnectionStore(root, { assertAvailable() {}, decrypt: value => value.toString() })
  return { root, file, store }
}

it('reads the saved device identity without requiring a running remote session', () => {
  const { store } = fixture('device')
  const saved = store.read()!
  assert.equal(saved.remoteBaseUrl, 'https://example.test')
  assert.equal(saved.credentialKind, 'device')
  assert.equal(saved.pairing.catalogId, pairing.catalogId)
})

it('rejects independent updater pairing and forgetting commands', () => {
  assert.equal(serverUpdateCommandSchema.safeParse({ action: 'pair', pairing: JSON.stringify(pairing) }).success, false)
  assert.equal(serverUpdateCommandSchema.safeParse({ action: 'forget' }).success, false)
  assert.equal(serverUpdateCommandSchema.safeParse({ action: 'connect', remoteBaseUrl: 'https://example.test', oneTimeToken: 'a'.repeat(64) }).success, true)
})

it('forgets the matching writer secret and pending claim while leaving unrelated files alone', async () => {
  const { store, root, file } = fixture('device')
  const pending = path.join(root, 'server-connection-pending.bin')
  const catalog = path.join(root, 'catalog.db')
  writeFileSync(pending, 'pending fixture'); writeFileSync(catalog, 'untouched fixture')
  const removed: string[] = []
  await store.forget({ deleteWriterSecret: async id => { removed.push(id) } })
  assert.deepEqual(removed, [pairing.catalogId])
  assert.equal(store.read(), null)
  assert.equal(existsSync(file), false)
  assert.equal(existsSync(pending), false)
  assert.equal(readFileSync(catalog, 'utf8'), 'untouched fixture')
})

it('retains pairing when deleting the writer secret fails', async () => {
  const { store, file } = fixture('device')
  await assert.rejects(store.forget({ deleteWriterSecret: async () => { throw new Error('storage unavailable') } }), /storage unavailable/)
  assert.equal(existsSync(file), true)
  assert.equal(store.read()!.credentialKind, 'device')
})

it('does not remove independent writer credentials when forgetting a legacy updater pairing', async () => {
  const { store } = fixture()
  assert.equal(store.read(), null, 'independent updater credentials are no longer a connection')
  await store.forget({ deleteWriterSecret: async () => { assert.fail('legacy updater pairing does not own writer credentials') } })
  assert.equal(store.read(), null)
})

it('refuses inconsistent origins and unavailable secure storage without deleting pairing', async () => {
  const { root, file, store } = fixture('device')
  writeFileSync(file, JSON.stringify({ pairing, remoteBaseUrl: 'https://other.test', credentialKind: 'device' }))
  await assert.rejects(store.forget({ deleteWriterSecret: async () => { assert.fail('invalid identity') } }), /身份不一致/)
  assert.equal(existsSync(file), true)
  const locked = createServerConnectionStore(root, { assertAvailable() { throw new Error('locked') }, decrypt: () => { assert.fail('must not decrypt') } })
  assert.throws(() => locked.read(), /locked/)
})
