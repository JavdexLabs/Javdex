import { it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { SCHEMA_SQL, SCAN_AUDIT_ENTRIES_SCHEMA_SQL } from './schema'
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from './migrations'
import { releasedV15Database } from '../testFixtures/releasedV15Database'

interface SchemaRow { type: string; name: string; tbl_name: string; sql: string | null }

function schema(db: Database.Database): SchemaRow[] {
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' OR type='index' ORDER BY name").all() as SchemaRow[]
  // Git checkout line endings must not change the logical schema comparison.
  return rows.map(row => ({ ...row, sql: row.sql?.replaceAll('\r\n', '\n') ?? null }))
}

function quote(name: string): string { return `"${name.replaceAll('"', '""')}"` }

function snapshot(db: Database.Database, tables: string[]) {
  return tables.map(name => {
    const columns = (db.pragma(`table_info(${quote(name)})`) as { name: string }[]).map(column => quote(column.name))
    return { name, rows: db.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${columns.join(',')}`).all() }
  })
}

function checkIntegrity(db: Database.Database) {
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }])
}

function v15(): Database.Database {
  const db = releasedV15Database()
  try {
    db.exec(`INSERT INTO media_libraries(id,name,status) VALUES (2,'legacy archived','archived');
      INSERT INTO media_library_roots(id,library_id,path,normalized_path) VALUES (10,1,'/legacy/one','/legacy/one'),(20,2,'/legacy/two','/legacy/two');
      INSERT INTO videos(id,code,title) VALUES (1,'V16-ONE','legacy title'),(2,'V16-TWO','second');
      INSERT INTO library_video_memberships(library_id,video_id,is_hidden,discovery_key,added_at,updated_at)
        VALUES (1,1,0,1,'old','old'),(2,1,1,2,'old','old'),(1,2,0,3,'old','old');
      INSERT INTO tags(id,name) VALUES (1,'legacy manual'),(2,'legacy scraped');
      INSERT INTO video_tag(video_id,tag_id,origin,source,created_at)
        VALUES (1,1,'manual',NULL,'old'),(1,2,'scraped','legacy-source','old');
      INSERT INTO agent_runs(id,use_case,status,config_revision,config_snapshot_json,runtime_id,product_state_json,created_at,updated_at)
        VALUES ('legacy-agent','plugin-developer','closed','old','invalid config','pi','invalid state','old','old');`)

    const insert = db.prepare(`INSERT INTO library_scan_runs
      (id,library_id,config_revision,trigger,status,started_at,finished_at,summary_json,audit_json,error_summary)
      VALUES (?,?,1,'manual','completed','before','after',?,?,'legacy diagnostic')`)
    const legacyAudit = (version: number, libraryId: number, runId: string) => JSON.stringify({
      schemaVersion: version, libraryId, runId, configRevision: 1, trigger: 'manual',
      status: 'success', startedAt: 'before', finishedAt: 'after',
      files: [{ rootId: libraryId === 1 ? 10 : 20, filePath: '/legacy/unknown.mp4', sourceKind: 'local', outcome: 'unrecognized' }],
      removedResources: [], promotedResources: [], deletedVideos: [], pendingGroups: [], note: '保留\u0000转义'
    }, null, 2) + '\n'
    for (const [index, body] of [
      legacyAudit(1, 1, 'legacy-0'), legacyAudit(2, 2, 'legacy-1'),
      '{damaged legacy JSON', '', null
    ].entries()) {
      insert.run(`legacy-${index}`, index === 1 ? 2 : 1, '{ "untouched": true }\n', body)
    }
    db.exec(`UPDATE media_library_scan_state SET active_run_id='legacy-0',last_status='completed',
        last_summary_json='{ "runId": "legacy-0" }',revision=7 WHERE library_id=1;
      INSERT INTO library_unrecognized_files(library_id,root_id,file_path,normalized_path,reason,scan_run_id,last_seen_at)
        VALUES (1,10,'/legacy/one/unknown.mp4','/legacy/one/unknown.mp4','legacy reason','legacy-0','old');`)
    checkIntegrity(db)
    return db
  } catch (error) { db.close(); throw error }
}

function assertUpgrade(db: Database.Database, before: ReturnType<typeof snapshot>) {
  migrateDatabase(db)
  assert.equal(CURRENT_SCHEMA_VERSION, 16)
  assert.equal(db.pragma('user_version', { simple: true }), 16)
  assert.deepEqual(snapshot(db, before.map(table => table.name)), before)
  checkIntegrity(db)
  const fresh = new Database(':memory:')
  try {
    fresh.pragma('foreign_keys = ON')
    fresh.exec(SCHEMA_SQL)
    // Compare all tables, explicit indexes and triggers, including unchanged legacy definitions.
    assert.deepEqual(schema(db), schema(fresh))
  } finally { fresh.close() }
}

it('adds combined V16 to the released V15 schema without rewriting any legacy data or relationships', () => {
  const db = v15()
  try {
    const oldSchema = schema(db)
    const before = snapshot(db, oldSchema.filter(row => row.type === 'table').map(row => row.name))
    const auditBytes = () => db.prepare('SELECT id,typeof(audit_json) AS kind,hex(CAST(audit_json AS BLOB)) AS bytes FROM library_scan_runs ORDER BY id').all()
    const originalBytes = auditBytes()
    assertUpgrade(db, before)
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
    const added = schema(db).filter(row => !oldSchema.some(old => old.name === row.name))
    assert.equal(added.filter(row => row.type === 'table').length, 3)
    for (const table of added.filter(row => row.type === 'table')) {
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table.name)}`).get() as { n: number }).n, 0)
    }
    assert.deepEqual(schema(db).filter(row => row.name !== 'idx_video_tag_tag_id' && oldSchema.some(old => old.name === row.name)), oldSchema.filter(row => row.name !== 'idx_video_tag_tag_id'))
    assert.deepEqual(auditBytes(), originalBytes)
    // A second startup must remain data- and schema-idempotent.
    assertUpgrade(db, before)
    assert.deepEqual(auditBytes(), originalBytes)
  } finally { db.close() }
})

for (const foreignKeys of [0, 1]) {
  it(`rolls back all V16 DDL and version, preserves foreign_keys=${foreignKeys}, then retries`, (t) => {
    const db = v15()
    try {
      db.pragma(`foreign_keys = ${foreignKeys}`)
      const oldSchema = schema(db)
      const before = snapshot(db, oldSchema.filter(row => row.type === 'table').map(row => row.name))
      const exec = db.exec
      let injected = false
      const fault = t.mock.method(db, 'exec', (sql: string) => {
        const result = exec.call(db, sql)
        if (sql.includes(SCAN_AUDIT_ENTRIES_SCHEMA_SQL.trim())) {
          injected = true
          assert.equal(db.inTransaction, true)
          assert.equal(schema(db).filter(row => row.type === 'table').length, before.length + 3,
            'All three new tables must actually exist before injecting the failure')
          throw new Error('V16 interrupted after new DDL')
        }
        return result
      })
      assert.throws(() => migrateDatabase(db), /V16 interrupted after new DDL/)
      assert.equal(injected, true)
      assert.equal(db.inTransaction, false)
      assert.equal(db.pragma('user_version', { simple: true }), 15)
      assert.equal(db.pragma('foreign_keys', { simple: true }), foreignKeys)
      assert.deepEqual(schema(db), oldSchema)
      assert.deepEqual(snapshot(db, before.map(table => table.name)), before)
      checkIntegrity(db)
      fault.mock.restore()
      assertUpgrade(db, before)
      assert.equal(db.pragma('foreign_keys', { simple: true }), foreignKeys)
    } finally { t.mock.restoreAll(); db.close() }
  })
}
