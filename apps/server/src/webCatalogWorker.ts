import { parentPort, workerData } from 'node:worker_threads'
import { openReadOnlyDatabaseAtPath } from '@library/db/database'
import { WebCatalogQueryReader } from '@http/catalogQueryReader'
import type { WebBrowseQuery } from '@http/catalogQueryRequest'

const port = parentPort
if (!port || typeof workerData?.databasePath !== 'string') {
  throw new Error('Invalid web catalog reader startup')
}

const connection = openReadOnlyDatabaseAtPath(workerData.databasePath)
const reader = new WebCatalogQueryReader(connection)

port.on('close', () => {
  if (connection.open) connection.close()
})

port.on(
  'message',
  (
    message:
      | { type: 'close' }
      | {
          type: 'read'
          id: number
          operation: 'web-browse' | 'web-home' | 'web-collections'
          query?: WebBrowseQuery | { seed: string }
        }
  ) => {
    if (message.type === 'close') {
      connection.close()
      port.close()
      return
    }
    if (message.type !== 'read' || !Number.isSafeInteger(message.id) || message.id <= 0) {
      throw new Error('Invalid web catalog reader command')
    }
    try {
      const result =
        message.operation === 'web-home'
          ? reader.home((message.query as { seed: string }).seed)
          : message.operation === 'web-browse'
            ? reader.browse(message.query as WebBrowseQuery)
            : reader.collections()
      port.postMessage({ type: 'result', id: message.id, result })
    } catch (error) {
      port.postMessage({
        type: 'error',
        id: message.id,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
)
port.postMessage({ type: 'ready' })
