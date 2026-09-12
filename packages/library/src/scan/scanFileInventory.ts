import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'

export const SCAN_FILE_INVENTORY_MAX_ROWS = 256
export const SCAN_FILE_INVENTORY_MAX_BYTES = 1024 * 1024

type FileEntry = { filePath: string; root: Readonly<MediaLibraryRoot> }
export interface ScanFileInventory extends Iterable<FileEntry> {
  /** True only when this append synchronously flushed a batch. A thrown append is not accepted. */
  append(filePath: string, rootId: number): boolean
  seal(): void
  dispose(): void
}

function rootSnapshots(roots: readonly Readonly<MediaLibraryRoot>[]): Map<number, Readonly<MediaLibraryRoot>> {
  const snapshots = new Map<number, Readonly<MediaLibraryRoot>>()
  for (const root of roots) {
    if (!Number.isSafeInteger(root.id) || root.id <= 0 || snapshots.has(root.id)) throw new Error('Invalid inventory root')
    snapshots.set(root.id, Object.isFrozen(root) ? root : Object.freeze({ ...root }))
  }
  return snapshots
}

function pathBytes(filePath: string): number {
  if (typeof filePath !== 'string' || !filePath) throw new Error('Invalid inventory path')
  const bytes = Buffer.byteLength(filePath, 'utf8')
  if (bytes > SCAN_FILE_INVENTORY_MAX_BYTES) throw new Error('Scan inventory path exceeds 1 MiB UTF-8 limit')
  return bytes
}

/** TEMP-only scratch inventory. No cursor survives a yield; readers may perform business writes.
 * Bounds cover buffered/projected path bytes, not total scan memory or SQLite TEMP storage.
 * Creation and mutations require no caller transaction; reads may run inside one.
 * Frozen input roots are reused; mutable roots are copied once so later mutations cannot change scope.
 */
export function createScanFileSpool(database: Database.Database, roots: readonly Readonly<MediaLibraryRoot>[]): ScanFileInventory {
  if (database.inTransaction) throw new Error('Scan file spool cannot be created inside a caller transaction')
  const snapshots = rootSnapshots(roots)
  const table = `scan_file_inventory_${randomUUID().replaceAll('-', '')}`
  database.transaction(() => {
    database.exec(`CREATE TEMP TABLE ${table} (
      ordinal INTEGER PRIMARY KEY, root_id INTEGER NOT NULL, path TEXT NOT NULL,
      path_bytes INTEGER NOT NULL CHECK(path_bytes = length(CAST(path AS BLOB)))
    )`)
  })()
  let buffer: Array<{ filePath: string; rootId: number; bytes: number }> = []
  let bufferedBytes = 0, ordinal = 0
  let sealed = false, closing = false, disposed = false
  const assertOpen = () => {
    if (closing || disposed || !database.open) throw new Error('Scan inventory is closed')
  }
  const assertOutsideTransaction = () => {
    if (database.inTransaction) throw new Error('Scan file spool mutations cannot run inside a caller transaction')
  }
  const flush = () => {
    if (!buffer.length) return
    database.transaction(() => {
      const insert = database.prepare(`INSERT INTO temp.${table}(ordinal,root_id,path,path_bytes) VALUES(?,?,?,?)`)
      for (let index = 0; index < buffer.length; index++) {
        const row = buffer[index]
        insert.run(ordinal + index + 1, row.rootId, row.filePath, row.bytes)
      }
    })()
    ordinal += buffer.length
    buffer = []
    bufferedBytes = 0
  }
  return {
    append(filePath, rootId) {
      assertOpen()
      assertOutsideTransaction()
      if (sealed) throw new Error('Scan inventory is sealed')
      if (!snapshots.has(rootId)) throw new Error('Unknown inventory root')
      const bytes = pathBytes(filePath)
      let flushed = false
      if (bufferedBytes + bytes > SCAN_FILE_INVENTORY_MAX_BYTES) { flush(); flushed = true }
      buffer.push({ filePath, rootId, bytes })
      bufferedBytes += bytes
      if (buffer.length === SCAN_FILE_INVENTORY_MAX_ROWS || bufferedBytes === SCAN_FILE_INVENTORY_MAX_BYTES) {
        try { flush(); flushed = true } catch (error) {
          // The caller can retry this same append; earlier buffered rows remain intact.
          buffer.pop()
          bufferedBytes -= bytes
          throw error
        }
      }
      return flushed
    },
    seal() { assertOpen(); assertOutsideTransaction(); if (!sealed) { flush(); sealed = true } },
    dispose() {
      if (disposed) return
      if (database.open) assertOutsideTransaction()
      closing = true
      if (database.open) database.exec(`DROP TABLE IF EXISTS temp.${table}`)
      buffer = []
      bufferedBytes = 0
      disposed = true
    },
    *[Symbol.iterator]() {
      assertOpen()
      if (!sealed) throw new Error('Scan inventory must be sealed before reading')
      let after = 0
      while (true) {
        assertOpen()
        const metadata = database.prepare(`SELECT ordinal,path_bytes FROM temp.${table}
          WHERE ordinal>? ORDER BY ordinal LIMIT ${SCAN_FILE_INVENTORY_MAX_ROWS}`).all(after) as Array<{ ordinal: number; path_bytes: number }>
        if (!metadata.length) return
        let bytes = 0, last = after
        for (const row of metadata) {
          if (row.path_bytes > SCAN_FILE_INVENTORY_MAX_BYTES) throw new Error('Scan inventory stored path exceeds byte limit')
          if (bytes + row.path_bytes > SCAN_FILE_INVENTORY_MAX_BYTES) break
          bytes += row.path_bytes
          last = row.ordinal
        }
        const rows = database.prepare(`SELECT ordinal,root_id,path FROM temp.${table}
          WHERE ordinal>? AND ordinal<=? ORDER BY ordinal LIMIT ${SCAN_FILE_INVENTORY_MAX_ROWS}`).all(after, last) as Array<{ ordinal: number; root_id: number; path: string }>
        for (const row of rows) {
          assertOpen()
          yield { filePath: row.path, root: snapshots.get(row.root_id)! }
        }
        after = last
      }
    }
  }
}

/** Detailed/legacy oracle, intentionally keeps its complete file list in memory. */
export function createMemoryScanFileInventory(roots: readonly Readonly<MediaLibraryRoot>[]): ScanFileInventory {
  const snapshots = rootSnapshots(roots), files: FileEntry[] = []
  let sealed = false, disposed = false
  const assertOpen = () => { if (disposed) throw new Error('Scan inventory is closed') }
  return {
    append(filePath, rootId) {
      assertOpen()
      if (sealed) throw new Error('Scan inventory is sealed')
      const root = snapshots.get(rootId)
      if (!root) throw new Error('Unknown inventory root')
      pathBytes(filePath)
      files.push({ filePath, root })
      return false
    },
    seal() { assertOpen(); sealed = true },
    dispose() { files.length = 0; disposed = true },
    *[Symbol.iterator]() {
      assertOpen()
      if (!sealed) throw new Error('Scan inventory must be sealed before reading')
      for (const file of files) { assertOpen(); yield file }
    }
  }
}
