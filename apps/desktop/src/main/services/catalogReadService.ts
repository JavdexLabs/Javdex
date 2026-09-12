import { getDatabaseReadRevision, getDb } from '@library/db/database'
import { CatalogReadWorkerClient } from './catalogReadWorkerClient'
import { createCatalogReadWorkerTransport } from './catalogReadWorkerTransport'

let workerEntryPath: string | undefined

export function configureCatalogReadWorkerEntry(entryPath: string): void {
  const trimmed = entryPath.trim()
  if (!trimmed) throw new Error('Catalog read worker entry path is required')
  workerEntryPath = trimmed
}

function resolveCatalogReadWorkerEntry(): string {
  if (!workerEntryPath) throw new Error('Catalog read worker entry path is not configured')
  return workerEntryPath
}

/** Lazy startup occurs only after normal writer initialization and IPC registration. */
export const catalogReadService = new CatalogReadWorkerClient({
  contextProvider: () => {
    const connection = getDb()
    const revision = getDatabaseReadRevision(connection)
    return { identity: connection, path: connection.name,
      revision: JSON.stringify([revision.changes, revision.dataVersion, connection.pragma('schema_version', { simple: true })]) }
  },
  transportFactory: context => createCatalogReadWorkerTransport(resolveCatalogReadWorkerEntry(), context.path)
})
