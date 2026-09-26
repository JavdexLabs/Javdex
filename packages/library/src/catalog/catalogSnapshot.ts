import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { ASSET_MEDIA_SUBDIRS } from '@library/assetStoragePaths'
import { decryptBlob, isEncryptedBlob } from '@library/assetCrypto'
import { getPathAlias } from '@library/assetPathAliases'
import { structuredError } from '@shared/protocol/errors'
import { digestRequest } from './catalogSecrets'
import { walkFiles, posixRel, sha256File } from './catalogMigrationArchive'
function sqlLiteral(value: string): string { return "'" + value.replace(/'/g, "''") + "'" }

export function walkOfficialImages(imagesDir: string): string[] {
  const files: string[] = []
  for (const subdir of ASSET_MEDIA_SUBDIRS) {
    const root = path.join(imagesDir, subdir)
    if (!fs.existsSync(root)) continue
    for (const abs of walkFiles(root)) {
      files.push(posixRel(imagesDir, abs))
    }
  }
  return files.sort()
}

export function availableBytes(dir: string): number {
  fs.mkdirSync(dir, { recursive: true })
  const stat = fs.statfsSync(dir)
  return Number(stat.bavail) * Number(stat.bsize)
}

export function digestImages(imagesDir: string, rels: string[]): { count: number; digest: string } {
  const payload = rels.map((rel) => {
    const abs = path.join(imagesDir, rel)
    const stat = fs.statSync(abs)
    return { rel, size: stat.size, sha256: sha256File(abs) }
  })
  return { count: rels.length, digest: digestRequest(payload) }
}

export function copyOfficialImages(fromDir: string, toDir: string): string[] {
  const copied: string[] = []
  for (const rel of walkOfficialImages(fromDir)) {
    const dest = path.join(toDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(fromDir, rel), dest)
    copied.push(rel)
  }
  return copied
}

export function snapshotLiveCatalog(database: Database.Database, destPath: string): void {
  if (!database.name || database.name === ':memory:') {
    throw structuredError('UNSUPPORTED_CAPABILITY', '内存资料库不能启用迁入')
  }
  database.pragma('wal_checkpoint(TRUNCATE)')
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.copyFileSync(database.name, destPath)
}

export function restoreCatalogFromSnapshot(database: Database.Database, snapshotPath: string): void {
  database.exec(`ATTACH DATABASE ${sqlLiteral(snapshotPath)} AS preroll`)
  try {
    database.transaction(() => {
      copyAttachedCatalog(database, 'preroll')
    })()
  } finally {
    try {
      database.exec('DETACH DATABASE preroll')
    } catch {
      // Detach after a rolled-back attach is optional.
    }
  }
}

export const OFFICIAL_IMAGE_COLUMNS = [
  ['videos', 'cover_path'], ['videos', 'poster_path'],
  ['actresses', 'avatar_path'], ['actresses', 'avatar_source_path'], ['actresses', 'poster_path'],
  ['playlists', 'cover_path'], ['video_assets', 'local_path'], ['actress_gallery_assets', 'local_path'],
  ['organizations', 'image_path'], ['directors', 'image_path'], ['series', 'image_path']
] as const

export function referencedOfficialImages(db: Database.Database): string[] {
  const rows = db.prepare(OFFICIAL_IMAGE_COLUMNS.map(([table, column]) =>
    `SELECT ${column} AS rel FROM ${table} WHERE ${column} IS NOT NULL AND ${column} != ''`
  ).join(' UNION ')).all() as Array<{ rel: string }>
  return rows.map(row => row.rel).sort()
}

export function remapAssetPathOn(
  database: Database.Database,
  fromRel: string,
  toRel: string | null
): void {
  for (const [table, column] of OFFICIAL_IMAGE_COLUMNS) {
    database.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(toRel, fromRel)
  }
}

export function decryptStagedOfficialImages(
  stagedImages: string,
  database: Database.Database,
  rels = walkOfficialImages(stagedImages)
): void {
  for (const rel of rels) {
    const abs = path.join(stagedImages, rel)
    const blob = fs.readFileSync(abs)
    if (!isEncryptedBlob(blob)) continue
    const plainRel = getPathAlias(rel)
    if (!plainRel) {
      throw structuredError('RECOVERY_REQUIRED', `缺少加密路径别名，无法在迁库中解密：${rel}`)
    }
    const { data } = decryptBlob(blob)
    const plainAbs = path.join(stagedImages, plainRel)
    fs.mkdirSync(path.dirname(plainAbs), { recursive: true })
    fs.writeFileSync(plainAbs, data)
    if (plainAbs !== abs) fs.unlinkSync(abs)
    if (plainRel !== rel) remapAssetPathOn(database, rel, plainRel)
  }
}

export function listUserTables(database: Database.Database): string[] {
  return (
    database
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name)
}

export function copyAttachedCatalog(dest: Database.Database, alias: string): void {
  dest.pragma('defer_foreign_keys = ON')
  for (const name of listUserTables(dest)) {
    dest.exec(`DELETE FROM "${name}"`)
  }
  const names = dest
    .prepare(
      `SELECT name FROM ${alias}.sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    )
    .all() as Array<{ name: string }>
  for (const { name } of names) {
    const quote = (value: string): string => '"' + value.replace(/"/g, '""') + '"'
    const columns = (dest.prepare(`PRAGMA table_info(${quote(name)})`).all() as Array<{ name: string }>).map(column => quote(column.name)).join(', ')
    dest.exec(`INSERT INTO ${quote(name)} (${columns}) SELECT ${columns} FROM ${alias}.${quote(name)}`)
  }
  dest.pragma('defer_foreign_keys = OFF')
}
