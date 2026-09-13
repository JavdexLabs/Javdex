import Database from 'better-sqlite3'
import type { CatalogTaskSnapshot } from '@shared/protocol/tasks'
import type { DesktopWorkStore } from '../application/desktopPorts'
import { ensureAgentWorkSchema } from './agentWorkCopy'

export type WorkStorePrepStatus = 'idle' | 'copying' | 'ready'

export interface DesktopWorkStoreHandle extends DesktopWorkStore {
  readonly filePath: string
  prepStatus(): WorkStorePrepStatus
  beginCopy(): void
  markReady(): void
  putVerification(operationId: string, catalogId: string): void
  database(): Database.Database
  close(): void
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS work_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_tasks (
  task_id TEXT PRIMARY KEY,
  catalog_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS operation_verifications (
  operation_id TEXT PRIMARY KEY,
  catalog_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`

function parsePrepStatus(value: string | undefined): WorkStorePrepStatus {
  if (value === 'copying' || value === 'ready') return value
  return 'idle'
}

export function openDesktopWorkStore(filePath: string): DesktopWorkStoreHandle {
  const db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  ensureAgentWorkSchema(db)

  const readMeta = db.prepare('SELECT value FROM work_meta WHERE key = ?')
  const writeMeta = db.prepare(
    'INSERT INTO work_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  const readTask = db.prepare('SELECT snapshot_json FROM catalog_tasks WHERE task_id = ?')
  const writeTask = db.prepare(
    `INSERT INTO catalog_tasks(task_id, catalog_id, snapshot_json)
     VALUES (@taskId, @catalogId, @snapshot)
     ON CONFLICT(task_id) DO UPDATE SET catalog_id = excluded.catalog_id, snapshot_json = excluded.snapshot_json`
  )
  const listVerifications = db.prepare(
    'SELECT operation_id AS operationId, catalog_id AS catalogId FROM operation_verifications'
  )
  const writeVerification = db.prepare(
    `INSERT INTO operation_verifications(operation_id, catalog_id, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(operation_id) DO UPDATE SET catalog_id = excluded.catalog_id`
  )

  const handle: DesktopWorkStoreHandle = {
    filePath,
    database(): Database.Database {
      return db
    },
    prepStatus(): WorkStorePrepStatus {
      const row = readMeta.get('prepStatus') as { value: string } | undefined
      return parsePrepStatus(row?.value)
    },
    beginCopy(): void {
      if (handle.prepStatus() === 'ready') return
      writeMeta.run('prepStatus', 'copying')
    },
    markReady(): void {
      writeMeta.run('prepStatus', 'ready')
    },
    async getTask(taskId): Promise<CatalogTaskSnapshot | null> {
      const row = readTask.get(taskId) as { snapshot_json: string } | undefined
      return row ? (JSON.parse(row.snapshot_json) as CatalogTaskSnapshot) : null
    },
    async putTask(task): Promise<void> {
      writeTask.run({
        taskId: task.taskId,
        catalogId: task.catalogId,
        snapshot: JSON.stringify(task)
      })
    },
    async listOpenVerifications(): Promise<Array<{ operationId: string; catalogId: string }>> {
      return listVerifications.all() as Array<{ operationId: string; catalogId: string }>
    },
    putVerification(operationId, catalogId): void {
      writeVerification.run(operationId, catalogId, new Date().toISOString())
    },
    close(): void {
      db.close()
    }
  }
  return handle
}
