import { it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { PluginDevAgentWorkLogEntry } from '@shared/pluginDevTypes'
import { AGENT_PLATFORM_SCHEMA_SQL } from '@library/db/schema'
import { AgentRunStore } from '../../agent-platform/agentRunStore'
import { appendPluginWorkLog, readPluginWorkLog, type PersistedPluginWorkLog, type PluginWorkLogReference } from './workLogPersistence'

type State = { schemaVersion: number; workLog: PersistedPluginWorkLog; summary: string }
function entry(index: number): PluginDevAgentWorkLogEntry {
  return { at: '2026-09-10T00:00:00Z', kind: 'user_message', sessionId: 'run', source: 'continue', text: `message-${index}` }
}
function fixture(legacy: PluginDevAgentWorkLogEntry[] = []) {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(AGENT_PLATFORM_SCHEMA_SQL)
  db.prepare(`INSERT INTO agent_runs
    (id,use_case,status,config_revision,config_snapshot_json,runtime_id,product_state_json,created_at,updated_at)
    VALUES ('run','plugin-developer','waiting_user','test','{}','pi',?,'now','now')`)
    .run(JSON.stringify({ schemaVersion: 1, workLog: legacy, summary: 'old' }))
  const store = new AgentRunStore(() => db)
  const save = (entries: PluginDevAgentWorkLogEntry[]) => store.updateProductStateFrom<State>('run', 'waiting_user', (current) => ({
    schemaVersion: 2, summary: 'new', workLog: appendPluginWorkLog('run', current.productState.workLog, entries, store)
  }))
  return { db, store, save }
}

it('migrates a legacy log once, preserves message/event order, and reads only its committed journal interval', () => {
  const original = [entry(0), { at: '2026-09-10T00:00:01Z', kind: 'event' as const,
    event: { type: 'step_start' as const, sessionId: 'run', step: 1 } }]
  const { db, store, save } = fixture(original)
  try {
    assert.deepEqual(readPluginWorkLog('run', store.getRun<State>('run')!.productState.workLog, store), original)
    assert.equal(store.getProductJournalCursor('run'), 0)
    const all = [...original, ...Array.from({ length: 1001 }, (_, index) => entry(index + 1))]
    store.appendProductEvent('run', undefined, 'unrelated', { ignored: true })
    const first = save(all)
    const cursor = store.getProductJournalCursor('run')
    assert.equal(first.schemaVersion, 2)
    assert.equal(Array.isArray(first.workLog), false)
    assert.deepEqual(readPluginWorkLog('run', first.workLog, store), all)
    save(all)
    assert.equal(store.getProductJournalCursor('run'), cursor)
    store.appendProductEvent('run', undefined, 'runtime.other', {})
    all.push(entry(1003))
    const next = save(all)
    assert.deepEqual(readPluginWorkLog('run', next.workLog, store), all)
    db.prepare(`INSERT INTO agent_product_journal (run_id,event_type,payload_json,created_at)
      VALUES ('run','corrupt-future','not JSON','now')`).run()
    assert.deepEqual(readPluginWorkLog('run', first.workLog, store), all.slice(0, -1))
    assert.deepEqual(readPluginWorkLog('run', next.workLog, store), all)
  } finally { db.close() }
})

it('rolls back journal appends when product state commit fails and retries without duplicates', () => {
  const { db, store, save } = fixture([entry(0)])
  try {
    const initial = store.getRun<State>('run')!.productState
    db.exec(`CREATE TRIGGER reject_state BEFORE UPDATE OF product_state_json ON agent_runs
      BEGIN SELECT RAISE(ABORT, 'state failure'); END`)
    assert.throws(() => save([entry(0), entry(1)]), /state failure/)
    assert.deepEqual(store.getRun<State>('run')!.productState, initial)
    assert.equal(store.getProductJournalCursor('run'), 0)
    db.exec('DROP TRIGGER reject_state')
    const migrated = save([entry(0), entry(1)])
    const cursor = store.getProductJournalCursor('run')
    db.exec(`CREATE TRIGGER reject_entry BEFORE INSERT ON agent_product_journal
      WHEN json_extract(NEW.payload_json, '$.index') = 3 BEGIN SELECT RAISE(ABORT, 'entry failure'); END`)
    assert.throws(() => save([entry(0), entry(1), entry(2), entry(3)]), /entry failure/)
    assert.deepEqual(store.getRun<State>('run')!.productState, migrated)
    assert.equal(store.getProductJournalCursor('run'), cursor)
    db.exec('DROP TRIGGER reject_entry')
    const retried = save([entry(0), entry(1), entry(2), entry(3)])
    assert.deepEqual(readPluginWorkLog('run', retried.workLog, store), [entry(0), entry(1), entry(2), entry(3)])
    assert.equal((db.prepare('SELECT COUNT(*) AS total FROM agent_product_journal').get() as { total: number }).total, 4)
  } finally { db.close() }
})

it('rejects changed legacy prefixes, shrinking histories, missing rows and malformed references without rewriting data', () => {
  const { db, store, save } = fixture([entry(0)])
  try {
    assert.throws(() => save([entry(1)]), /prefix changed/)
    const committed = save([entry(0), entry(1)])
    const ref = committed.workLog as PluginWorkLogReference
    assert.throws(() => save([entry(0)]), /cannot shrink/)
    for (const invalid of [{ ...ref, count: -1 }, { ...ref, throughSeq: 0 }, { ...ref, afterSeq: 0.5 }]) {
      assert.throws(() => readPluginWorkLog('run', invalid, store), /Invalid/)
    }
    db.prepare('DELETE FROM agent_product_journal WHERE seq = ?').run(ref.throughSeq)
    assert.throws(() => readPluginWorkLog('run', ref, store), /incomplete/)
    assert.deepEqual(store.getRun<State>('run')!.productState, committed)
  } finally { db.close() }
})

it('keeps logical state+journal writes linear for 1k, 10k and 100k log entries', (t) => {
  const results: Array<{ entries: number; stateBytes: number; journalBytes: number }> = []
  for (const count of [1000, 10_000, 100_000]) {
    const { db, store, save } = fixture()
    try {
      let stateBytes = 0
      db.function('capture_state', (value: string) => { stateBytes += Buffer.byteLength(value); return 0 })
      db.exec(`CREATE TRIGGER capture_state AFTER UPDATE OF product_state_json ON agent_runs
        BEGIN SELECT capture_state(NEW.product_state_json); END`)
      const entries: PluginDevAgentWorkLogEntry[] = []
      let final: State | undefined
      db.transaction(() => {
        for (let index = 0; index < count; index++) {
          entries.push(entry(index))
          final = save(entries)
        }
      })()
      const row = db.prepare('SELECT COUNT(*) AS total, SUM(length(CAST(payload_json AS BLOB))) AS bytes FROM agent_product_journal')
        .get() as { total: number; bytes: number }
      assert.equal(row.total, count)
      assert.ok(stateBytes < count * 200)
      const restored = readPluginWorkLog('run', final!.workLog, store)
      assert.deepEqual(restored, entries)
      results.push({ entries: count, stateBytes, journalBytes: row.bytes })
    } finally { db.close() }
  }
  assert.ok(results[2].stateBytes / results[1].stateBytes < 10.5)
  assert.ok(results[2].journalBytes / results[1].journalBytes < 10.5)
  t.diagnostic(JSON.stringify({ results, scope: 'In-memory SQLite logical JSON bytes; outer transaction amortizes test setup. Not WAL/device bytes, fsync latency, UI or cold recovery memory acceptance.' }))
})
