import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import type Database from 'better-sqlite3'

/** Read authoritative device state even while business is stopped for an update.
 * Open per check: a restore can atomically replace the database inode.
 * Only the already verified current release supplies the native SQLite driver.
 */
export function authorizeDeviceUpdate(releaseDirectory: string, dataDirectory: string, token: string): boolean {
  let database: Database.Database | undefined
  try {
    const Driver = createRequire(path.join(releaseDirectory, 'package.json'))('better-sqlite3') as typeof Database
    database = new Driver(path.join(dataDirectory, 'library.db'), { readonly: true, fileMustExist: true, timeout: 1000 })
    return Boolean(database.prepare('SELECT 1 FROM catalog_writer_credentials WHERE secret_digest = ? AND superseded_at IS NULL')
      .get(createHash('sha256').update(token).digest('hex')))
  } catch { return false }
  finally { database?.close() }
}
