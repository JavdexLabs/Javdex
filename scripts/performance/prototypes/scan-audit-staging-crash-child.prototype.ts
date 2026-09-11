/** UNSHIPPED scratch-only crash harness, launched by the prototype runner. */
import path from 'node:path'
import { initDatabaseAtPath } from '../../../src/main/db/database'
import { createPrototypeAuditStore } from './scan-audit-staging.prototype'
const [filename, library, runId, phase] = process.argv.slice(2)
if (!filename || path.basename(filename) !== 'PROTOTYPE-wipe-me.sqlite' ||
    !path.basename(path.dirname(filename)).startsWith('Javdex-PROTOTYPE-') || !process.send ||
    !['staged', 'uncommitted-publication'].includes(phase)) throw Error('Scratch crash harness only')
const libraryId = Number(library)
const db = initDatabaseAtPath(filename), store = createPrototypeAuditStore(db)
store.start(libraryId, runId, { libraryId, runId, schemaVersion: 2 })
store.writeBatch(libraryId, runId, Array.from({ length: 3 }, (_, i) => ({
  section: 'files' as const, key: `/crash-${i}`, entry: { filePath: `/crash-${i}`, outcome: 'added' }
})))
store.seal(libraryId, runId)
if (phase === 'uncommitted-publication') {
  // Hold an outer transaction open to expose deterministic uncommitted publication writes.
  db.exec('BEGIN IMMEDIATE')
  store.publish(libraryId, runId, () => {
    db.prepare("UPDATE library_scan_runs SET status='completed',finished_at='crash-finish' WHERE id=?").run(runId)
    db.prepare("UPDATE media_library_scan_state SET active_run_id=NULL,last_status='completed',last_summary_json='{}',revision=revision+1 WHERE library_id=?").run(libraryId)
  })
  if (!db.inTransaction) throw Error('Expected open publication transaction')
}
process.send({ ready: true, phase, inTransaction: db.inTransaction })
setInterval(() => {}, 1000) // Parent kills this exact process; no close/rollback handlers.
