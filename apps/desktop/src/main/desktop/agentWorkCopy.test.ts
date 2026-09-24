import { afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { copyAgentWorkTables, ensureAgentWorkSchema } from './agentWorkCopy'
import { openDesktopWorkStore, type DesktopWorkStoreHandle } from './workStore'

let root: string | undefined
let source: Database.Database | undefined
let store: DesktopWorkStoreHandle | undefined
afterEach(() => {
  source?.close()
  store?.close()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  source = undefined
  store = undefined
  root = undefined
})
function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-work-copy-'))
  source = new Database(path.join(root, 'catalog.db'))
  ensureAgentWorkSchema(source)
  store = openDesktopWorkStore(path.join(root, 'desktop-work.db'))
  store.beginCopy()
  const dest = store.database()
  dest.pragma('foreign_keys = ON')
  source.prepare(`INSERT INTO agent_runs(id,use_case,status,config_revision,config_snapshot_json,runtime_id,product_state_json,created_at,updated_at)
    VALUES('run','plugin-developer','closed','revision','{}','pi','{"value":"source"}','before','before')`).run()
  return { source, dest, store }
}
function assertDetached(dest: Database.Database) {
  assert.equal(dest.pragma('foreign_keys', { simple: true }), 1)
  assert.deepEqual((dest.prepare('PRAGMA database_list').all() as Array<{ name: string }>).map(row => row.name), ['main'])
}

it('copies record IDs, related rows and encrypted bytes without changing readable recovery content', () => {
  const { source, dest } = fixture()
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const plain = Buffer.from('{"messages":["历史恢复"],"generation":2}')
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  source.prepare(`INSERT INTO agent_execution_history(seq,run_id,runtime_id,codec_version,audit_json,recovery_ciphertext,content_hash,created_at)
    VALUES(42,'run','pi',1,'{}',?,'hash','before')`).run(encrypted)
  source.prepare("INSERT INTO agent_resource_cleanup(run_id,requested_at) VALUES('run','before')").run()
  const copied = copyAgentWorkTables(source, dest)
  assert.deepEqual(copied.tables.agent_execution_history, { source: 1, dest: 1 })
  assert.deepEqual(dest.prepare('SELECT * FROM agent_runs').all(), source.prepare('SELECT * FROM agent_runs').all())
  const history = dest.prepare('SELECT * FROM agent_execution_history WHERE seq=42').get() as { recovery_ciphertext: Buffer }
  assert.deepEqual(history, source.prepare('SELECT * FROM agent_execution_history WHERE seq=42').get())
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  assert.deepEqual(Buffer.concat([decipher.update(history.recovery_ciphertext), decipher.final()]), plain)
  assert.deepEqual(dest.prepare('PRAGMA foreign_key_check').all(), [])
  assertDetached(dest)
})

it('rejects equal-count content corruption inside the copy transaction and can retry', () => {
  const { source, dest, store } = fixture()
  dest.exec(`CREATE TRIGGER corrupt_copy AFTER INSERT ON agent_runs BEGIN
    UPDATE agent_runs SET product_state_json='{"value":"corrupted"}' WHERE id=NEW.id;
  END`)
  assert.throws(() => copyAgentWorkTables(source, dest), /复制内容不一致/)
  assert.equal(dest.prepare('SELECT 1 FROM agent_runs').get(), undefined)
  assert.equal(store.prepStatus(), 'copying')
  assertDetached(dest)
  dest.exec('DROP TRIGGER corrupt_copy')
  copyAgentWorkTables(source, dest)
  assert.deepEqual(dest.prepare('SELECT * FROM agent_runs').all(), source.prepare('SELECT * FROM agent_runs').all())
})

it('rejects orphaned source rows, rolls back the whole copy and restores connection settings', () => {
  const { source, dest, store } = fixture()
  source.pragma('foreign_keys = OFF')
  source.prepare("INSERT INTO agent_resource_cleanup(run_id,requested_at) VALUES('missing','before')").run()
  assert.throws(() => copyAgentWorkTables(source, dest), /外键校验失败/)
  assert.equal(dest.prepare('SELECT 1 FROM agent_runs').get(), undefined)
  assert.equal(store.prepStatus(), 'copying')
  assertDetached(dest)
  assert.ok(source.prepare("SELECT 1 FROM agent_resource_cleanup WHERE run_id='missing'").get())
})

it('never overwrites ready work records with stale source rows', () => {
  const { source, dest, store } = fixture()
  copyAgentWorkTables(source, dest)
  store.markReady()
  dest.prepare("UPDATE agent_runs SET product_state_json=? WHERE id='run'").run('{"value":"new work"}')
  assert.throws(() => copyAgentWorkTables(source, dest), /已就绪/)
  assert.deepEqual(dest.prepare("SELECT product_state_json FROM agent_runs WHERE id='run'").get(), { product_state_json: '{"value":"new work"}' })
  assertDetached(dest)
})
