import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import { getDb } from '@library/db/database'

export const JAVDEX_ROOT_MARKER = '.javdex-root'

function markerPath(mountPath: string): string {
  return path.join(mountPath, JAVDEX_ROOT_MARKER)
}

function tableReady(database: Database.Database): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'catalog_root_markers'")
      .get()
  )
}

/** Write the marker once inside the actual mount. Never recreate a lost initialized marker. */
export function initializeJavdexRootMarker(mountPath: string): void {
  const realMount = fs.realpathSync.native(mountPath)
  const file = markerPath(realMount)
  try {
    const existing = fs.lstatSync(file)
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('媒体挂载标记不是普通文件')
    }
    fs.accessSync(file, fs.constants.R_OK)
    if (fs.realpathSync.native(path.dirname(file)) !== realMount) {
      throw new Error('媒体挂载标记必须位于实际挂载内')
    }
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  fs.writeFileSync(file, '', { flag: 'wx', mode: 0o644 })
}

export function javdexRootMarkerReadable(mountPath: string): boolean {
  try {
    const realMount = fs.realpathSync.native(mountPath)
    const file = markerPath(realMount)
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile()) return false
    fs.accessSync(file, fs.constants.R_OK)
    return fs.realpathSync.native(path.dirname(file)) === realMount
  } catch {
    return false
  }
}

export function markJavdexRootInitialized(
  libraryId: number,
  rootId: number,
  database: Database.Database = getDb()
): void {
  if (!tableReady(database)) return
  database
    .prepare(
      `INSERT INTO catalog_root_markers(library_id, root_id, initialized_at)
       VALUES (?, ?, ?)
       ON CONFLICT(library_id, root_id) DO NOTHING`
    )
    .run(libraryId, rootId, new Date().toISOString())
}

export function isJavdexRootInitialized(
  libraryId: number,
  rootId: number,
  database: Database.Database = getDb()
): boolean {
  if (!tableReady(database)) return false
  return Boolean(
    database
      .prepare(
        'SELECT 1 AS ok FROM catalog_root_markers WHERE library_id = ? AND root_id = ?'
      )
      .get(libraryId, rootId)
  )
}

/**
 * Server roots that completed marker init must keep a readable marker in the live mount.
 * Local ADR-0024 roots never write this row, so identity/device checks remain unchanged.
 */
export function inspectJavdexRootMarker(root: Readonly<MediaLibraryRoot>): boolean {
  if (!isJavdexRootInitialized(root.libraryId, root.id)) return true
  return javdexRootMarkerReadable(root.realPath ?? root.path)
}
