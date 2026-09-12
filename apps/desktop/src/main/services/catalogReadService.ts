import { app } from 'electron'
import path from 'node:path'
import { getDatabaseReadRevision, getDb } from '@library/db/database'
import { CatalogReadWorkerClient } from './catalogReadWorkerClient'
import { createCatalogReadWorkerTransport } from './catalogReadWorkerTransport'

/** Lazy startup occurs only after normal writer initialization and IPC registration. */
export const catalogReadService = new CatalogReadWorkerClient({
  contextProvider: () => {
    const connection = getDb()
    const revision = getDatabaseReadRevision(connection)
    return { identity: connection, path: connection.name,
      revision: JSON.stringify([revision.changes, revision.dataVersion, connection.pragma('schema_version', { simple: true })]) }
  },
  transportFactory: context => createCatalogReadWorkerTransport(
    path.join(app.getAppPath(), 'out/main/catalogReadWorker.js'), context.path)
})
