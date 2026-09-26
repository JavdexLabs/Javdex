import fs from 'node:fs'
import { inspectBackupArtifacts, removeBackupArtifacts } from './catalogBackupCleanup'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, BACKUP_MAX_BYTES, BACKUP_CHUNK_BYTES, backupRequestSchema, type BackupJob, type BackupMapping, type BackupRequest, type BackupResponse, type BackupSummary } from '@shared/protocol/backup'
import { structuredError, toStructuredError } from '@shared/protocol/errors'
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from '@library/db/migrations'
import { registerReadFunctions } from '@library/db/database'
import { initializeJavdexRootMarker, markJavdexRootInitialized } from '@library/scan/javdexRootMarker'
import { resolveMountSelectionPath } from '@library/scan/mountSelection'
import { resolveLibraryUserDataPath } from '@library/runtime/host'
import { resolveMediaAssetsRoot, ASSET_MEDIA_SUBDIRS } from '@library/assetStoragePaths'
import { mediaAssetStore } from '@library/mediaAssetStore'
import { maintenanceTaskGate } from '@library/scan/maintenanceTaskGate'
import { revokeAllPlayGrants, notifyPlayGrantsRevoked } from './catalogPlay'
import { readCatalogIdentity, setCatalogFrozen } from './catalogIdentity'
import { digestRequest } from './catalogSecrets'
import { schemaDeclaration } from './catalogSchema'
import { compareBackupVersions, MIN_BACKUP_SCHEMA_VERSION } from './catalogBackupCompatibility'
import { countPendingBlockers } from './catalogMigrationState'
import { stripExportSecrets, applyMigrationTransforms } from './catalogMigrationApply'
import { availableBytes, referencedOfficialImages, copyAttachedCatalog, decryptStagedOfficialImages, remapAssetPathOn, walkOfficialImages } from './catalogSnapshot'
import { packMigrationArchive, unpackMigrationArchive, sha256File, posixRel } from './catalogMigrationArchive'

export interface BackupHost {
  appVersion: string
  mode: 'local' | 'remote'
  userDataPath?: string
  imagesDir?: string
  isolatedSource?: boolean
  onRestored?: (catalogId: string) => void
  onProgress?: (job: BackupJob) => void
}
interface StoredJob extends BackupJob {
  filesDeletionDigest?: string
  filesDeletedAt?: string
  recordDeletedAt?: string
  acceptedMissingDigest?: string
  catalogId: string
  epoch: number
  owner: string
  mappings?: BackupMapping[]
  targetStamp?: string
}
interface Manifest extends BackupSummary { files: Array<{ name: string; bytes: number; sha256: string }> }
const fileSchema = z.object({ name: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const manifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT), formatVersion: z.literal(BACKUP_FORMAT_VERSION),
  appVersion: z.string(), schemaVersion: z.number().int(), createdAt: z.string(),
  sourcePlatform: z.enum(['win32', 'linux', 'darwin']), sourceCatalogId: z.uuid(),
  counts: z.object({ libraries: z.number().int().nonnegative(), videos: z.number().int().nonnegative(), actresses: z.number().int().nonnegative(), playlists: z.number().int().nonnegative(), images: z.number().int().nonnegative() }).strict(),
  unrootedResources: z.number().int().nonnegative(),
  missingImages: z.array(z.string().refine(safeImagePath)).optional(),
  roots: z.array(z.object({ id: z.number().int().positive(), libraryId: z.number().int().positive(), name: z.string(), path: z.string() }).strict()),
  files: z.array(fileSchema)
}).strip()
const running = new Set<string>()
let maintenanceActive = false
export function isBackupMaintenanceActive(): boolean { return maintenanceActive }
const cancelled = new Set<string>()
const downloads = new Map<string, { active: number; until: number }>()
function downloadKey(host: BackupHost, id: string): string { return path.resolve(root(host), safeId(id)) }
function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return
  const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
function invalid(message: string): never { throw structuredError('INVALID_INPUT', message) }
class MissingBackupImagesError extends Error {
  constructor(readonly paths: string[]) { super(`缺少 ${paths.length} 张正式图片，请补齐图片或明确确认后继续备份`) }
}
function publicJob(job: StoredJob): BackupJob {
  const { owner: _owner, catalogId: _catalog, epoch: _epoch, mappings: _mappings, targetStamp: _stamp, acceptedMissingDigest: _accepted, recordDeletedAt: _deleted, filesDeletionDigest: _deleting, filesDeletedAt: _filesDeleted, ...result } = job
  return result
}
function safeId(id: string): string { return z.uuid().parse(id) }
function root(host: BackupHost): string { return path.join(host.userDataPath ?? resolveLibraryUserDataPath(), 'backups') }
function jobDir(host: BackupHost, id: string): string { return path.join(root(host), 'operations', safeId(id)) }
function archive(host: BackupHost, id: string): string { return path.join(root(host), `${safeId(id)}.javdex-backup`) }
function hideIncompleteArchive(host: BackupHost, job: StoredJob): void {
  if (job.kind !== 'backup') return
  const file = archive(host, job.id)
  if (fs.existsSync(file)) fs.renameSync(file, `${file}.failed`)
}
function images(host: BackupHost): string { return host.imagesDir ?? resolveMediaAssetsRoot() }
function readJob(host: BackupHost, id: string): StoredJob {
  return JSON.parse(fs.readFileSync(path.join(jobDir(host, id), 'job.json'), 'utf8')) as StoredJob
}
function writeJob(host: BackupHost, job: StoredJob): void {
  const dir = jobDir(host, job.id)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'job.json')
  const fd = fs.openSync(`${file}.tmp`, 'w', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(job)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(`${file}.tmp`, file)
  syncDirectory(dir)
}
function jobs(host: BackupHost): StoredJob[] {
  const dir = path.join(root(host), 'operations')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(id => z.uuid().safeParse(id).success).map(id => readJob(host, id))
}
const ROOTS_SQL = 'SELECT r.id, r.library_id AS libraryId, l.name, r.path FROM media_library_roots r JOIN media_libraries l ON l.id = r.library_id ORDER BY r.id'
function counts(db: Database.Database): BackupSummary['counts'] {
  const count = (table: string): number => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
  return { libraries: count('media_libraries'), videos: count('videos'), actresses: count('actresses'), playlists: count('playlists'), images: 0 }
}
function stamp(db: Database.Database): string {
  return digestRequest([readCatalogIdentity(db)?.catalogId, db.pragma('data_version', { simple: true }), db.prepare('SELECT total_changes() AS n').get()])
}
function assertIdle(db: Database.Database, pending: boolean): void {
  if (readCatalogIdentity(db)?.frozen) throw structuredError('MAINTENANCE_BUSY', '资料库正在维护，请稍后重试')
  const blockers = countPendingBlockers(db).filter(x => pending || x.startsWith('active-'))
  if (blockers.length) throw structuredError('MAINTENANCE_BUSY', '请先完成正在运行的任务' + (pending ? '和待确认事项' : ''))
  if (db.prepare("SELECT 1 FROM catalog_settings WHERE key LIKE 'catalog-mutation-intent:%' OR key LIKE 'catalog-file-maintenance:%' LIMIT 1").get()) {
    throw structuredError('MAINTENANCE_BUSY', '文件维护尚未完成')
  }
}
function assertSpace(dir: string, bytes: number): void {
  if (availableBytes(dir) < bytes + 64 * 1024 * 1024) throw structuredError('LIMIT_EXCEEDED', '磁盘空间不足，请清理后重试')
}
function checkCancelled(id: string): void { if (cancelled.has(id)) throw new Error('操作已取消') }
function assertSchema(source: Database.Database, target: Database.Database): void {
  const schema = (db: Database.Database): unknown => (db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Array<{ type: string; name: string; sql: string | null }>).map(row => ({ ...row, sql: schemaDeclaration(row.sql) }))
  if (digestRequest(schema(source)) !== digestRequest(schema(target))) invalid('备份数据库结构与当前版本不一致')
  if (source.pragma('quick_check', { simple: true }) !== 'ok' || (source.pragma('foreign_key_check') as unknown[]).length) invalid('备份数据库完整性检查失败')
}
function safeImagePath(rel: string): boolean {
  return ASSET_MEDIA_SUBDIRS.some(sub => rel.startsWith(`${sub}/`)) &&
    !rel.includes('\\') && !rel.includes(':') && rel.split('/').every(part => part && part !== '.' && part !== '..')
}
function stripBackupRuntime(db: Database.Database): void {
  stripExportSecrets(db)
  db.exec('DELETE FROM catalog_tasks; DELETE FROM catalog_settings; DELETE FROM catalog_identity;')
}

async function makeArchive(host: BackupHost, job: StoredJob, db: Database.Database): Promise<void> {
  if (!host.isolatedSource) return makeArchiveContents(host, job, db, db)
  const reader = new Database(db.name, { readonly: true, fileMustExist: true })
  db.exec('BEGIN IMMEDIATE')
  try { await makeArchiveContents(host, job, db, reader) }
  finally { db.exec('ROLLBACK'); reader.close() }
}
async function makeArchiveContents(host: BackupHost, job: StoredJob, db: Database.Database, reader: Database.Database): Promise<void> {
  let lastProgress = 0
  const report = (stage: NonNullable<BackupJob['progress']>['stage'], completed: number, total: number): boolean => {
    checkCancelled(job.id)
    if (job.progress?.stage === stage && completed !== total && Date.now() - lastProgress < 200) return false
    lastProgress = Date.now()
    job.progress = { stage, completed, total, updatedAt: new Date().toISOString() }
    writeJob(host, job); host.onProgress?.(publicJob(job))
    return true
  }
  const progress = async (stage: NonNullable<BackupJob['progress']>['stage'], completed: number, total: number): Promise<void> => {
    if (report(stage, completed, total)) await new Promise<void>(resolve => setImmediate(resolve))
    checkCancelled(job.id)
  }
  await progress('checking', 0, 0)
  const work = path.join(jobDir(host, job.id), 'export')
  fs.mkdirSync(work, { recursive: true })
  const sourceImages = images(host)
  const referenced = referencedOfficialImages(db)
  for (const rel of referenced) {
    if (!safeImagePath(rel)) invalid('正式图片引用包含非法路径')
  }
  const missing = referenced.filter(rel => !fs.existsSync(path.join(sourceImages, rel)))
  if (missing.length && job.acceptedMissingDigest !== digestRequest(missing)) throw new MissingBackupImagesError(missing)
  const missingSet = new Set(missing)
  const official = referenced.filter(rel => !missingSet.has(rel))
  const needed = fs.statSync(db.name).size + official.reduce((n, rel) => n + fs.statSync(path.join(sourceImages, rel)).size, 0)
  assertSpace(root(host), needed * 2)
  if (needed > BACKUP_MAX_BYTES) throw structuredError('LIMIT_EXCEEDED', '备份超过 64 GiB 上限')
  const dbFile = path.join(work, 'catalog', 'library.db')
  fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  await progress('database', 0, 0)
  await reader.backup(dbFile, { progress({ totalPages, remainingPages }) { report('database', totalPages - remainingPages, totalPages); return 256 } })
  const imageDir = path.join(work, 'images')
  let processed = 0
  await progress('copying', 0, official.length)
  for (const rel of official) {
    if (!safeImagePath(rel)) invalid('正式图片引用包含非法路径')
    const source = path.join(sourceImages, rel)
    if (!fs.existsSync(source)) invalid(`正式图片缺失，无法创建完整备份：${rel}`)
    if (!fs.realpathSync(source).startsWith(fs.realpathSync(sourceImages) + path.sep)) invalid('正式图片超出图片目录')
    const dest = path.join(imageDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(source, dest)
    await progress('copying', ++processed, official.length)
  }
  const copy = new Database(dbFile)
  let summary: BackupSummary
  try {
    copy.exec('BEGIN')
    summary = {
      format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, appVersion: host.appVersion,
      schemaVersion: CURRENT_SCHEMA_VERSION, createdAt: new Date().toISOString(), sourcePlatform: process.platform,
      sourceCatalogId: readCatalogIdentity(db)!.catalogId, counts: counts(copy),
      unrootedResources: (copy.prepare("SELECT count(*) AS n FROM video_resources WHERE kind = 'local' AND root_id IS NULL").get() as { n: number }).n,
      roots: copy.prepare(ROOTS_SQL).all() as BackupSummary['roots']
    }
    if (missing.length) {
      summary.missingImages = missing
      for (const rel of missing) remapAssetPathOn(copy, rel, null)
    }
    stripBackupRuntime(copy)
    processed = 0
    await progress('decrypting', 0, official.length)
    for (const rel of official) {
      decryptStagedOfficialImages(imageDir, copy, [rel])
      await progress('decrypting', ++processed, official.length)
    }
    // Keep archive member names short even after repeated cross-device restores.
    const plainImages = walkOfficialImages(imageDir)
    processed = 0
    await progress('paths', 0, plainImages.length)
    for (const rel of plainImages) {
      const sub = rel.split('/')[0]
      const next = `${sub}/${digestRequest(rel)}${path.extname(rel)}`
      if (next !== rel) {
        fs.renameSync(path.join(imageDir, rel), path.join(imageDir, next))
        remapAssetPathOn(copy, rel, next)
      }
      await progress('paths', ++processed, plainImages.length)
    }
    copy.exec('COMMIT')
    copy.pragma('wal_checkpoint(TRUNCATE)')
  } finally { if (copy.inTransaction) copy.exec('ROLLBACK'); copy.close() }
  summary.counts.images = walkOfficialImages(imageDir).length
  const members = [dbFile, ...walkOfficialImages(imageDir).map(rel => path.join(imageDir, rel))]
  const files: Manifest['files'] = []
  await progress('checksums', 0, members.length)
  for (const abs of members) {
    files.push({ name: posixRel(work, abs), bytes: fs.statSync(abs).size, sha256: sha256File(abs) })
    await progress('checksums', files.length, members.length)
  }
  const manifest: Manifest = { ...summary, files }
  const manifestPath = path.join(work, 'manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  job.phase = 'packing'; job.summary = summary; writeJob(host, job)
  await progress('packing', 0, 0)
  checkCancelled(job.id)
  const partial = `${archive(host, job.id)}.partial`
  await packMigrationArchive([{ name: 'manifest.json', absPath: manifestPath }, ...members.map(absPath => ({ name: posixRel(work, absPath), absPath }))], partial, { maxBytes: BACKUP_MAX_BYTES, onProgress: (completed, total) => { report('packing', completed, total) } })
  checkCancelled(job.id)
  job.bytes = fs.statSync(partial).size
  job.sha256 = sha256File(partial)
  const archiveFd = fs.openSync(partial, 'r+'); try { fs.fsyncSync(archiveFd) } finally { fs.closeSync(archiveFd) }
  fs.renameSync(partial, archive(host, job.id)); syncDirectory(root(host))
  job.transferred = job.bytes; job.fileName = `${job.id}.javdex-backup`
}

async function inspect(host: BackupHost, job: StoredJob, target: Database.Database): Promise<void> {
  if (job.transferred !== job.bytes || sha256File(archive(host, job.id)) !== job.sha256) invalid('备份传输不完整或校验失败')
  const dir = path.join(jobDir(host, job.id), `inspect-${randomUUID()}`)
  const extracted = await unpackMigrationArchive(archive(host, job.id), dir, { maxBytes: BACKUP_MAX_BYTES, availableBytes: availableBytes(jobDir(host, job.id)) - 64 * 1024 * 1024 })
  const manifestFile = path.join(dir, 'manifest.json')
  if (!fs.existsSync(manifestFile) || fs.statSync(manifestFile).size > 16 * 1024 * 1024) invalid('备份清单无效')
  const rawManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  if (rawManifest?.format !== BACKUP_FORMAT || rawManifest?.formatVersion !== BACKUP_FORMAT_VERSION) invalid('不支持此备份包格式（formatVersion），请使用兼容的软件版本')
  const manifest = manifestSchema.parse(rawManifest)
  if (compareBackupVersions(manifest.appVersion, host.appVersion) > 0) invalid('此备份由更高版本的 Javdex 创建，请升级软件后恢复')
  if (manifest.schemaVersion > CURRENT_SCHEMA_VERSION) invalid('备份数据库版本高于当前软件，请升级软件后恢复')
  if (manifest.schemaVersion < MIN_BACKUP_SCHEMA_VERSION) invalid(`此备份数据库版本过旧；当前支持版本 ${MIN_BACKUP_SCHEMA_VERSION} 至 ${CURRENT_SCHEMA_VERSION}`)
  if (new Set(manifest.files.map(x => x.name)).size !== manifest.files.length || extracted.files.length !== manifest.files.length + 1) invalid('备份文件清单不匹配')
  for (const file of manifest.files) {
    if (!extracted.files.includes(file.name) || (file.name !== 'catalog/library.db' && !ASSET_MEDIA_SUBDIRS.some(sub => file.name.startsWith(`images/${sub}/`)))) invalid('备份包含不允许的文件')
    const abs = path.join(dir, file.name)
    if (fs.statSync(abs).size !== file.bytes || sha256File(abs) !== file.sha256) invalid('备份文件校验失败')
  }
  const copy = new Database(path.join(dir, 'catalog/library.db'), { fileMustExist: true })
  const { files: _files, ...summary } = manifest
  try {
    if (Number(copy.pragma('user_version', { simple: true })) !== manifest.schemaVersion) invalid('备份清单与数据库实际版本不一致')
    if (copy.pragma('quick_check', { simple: true }) !== 'ok' || (copy.pragma('foreign_key_check') as unknown[]).length) invalid('备份数据库完整性检查失败')
    if ((copy.prepare("SELECT count(*) AS n FROM video_resources WHERE kind = 'local' AND root_id IS NULL").get() as { n: number }).n !== manifest.unrootedResources ||
      digestRequest(copy.prepare(ROOTS_SQL).all()) !== digestRequest(manifest.roots) ||
      digestRequest({ ...counts(copy), images: manifest.counts.images }) !== digestRequest(manifest.counts)) invalid('备份摘要与数据库不一致')
    const official = referencedOfficialImages(copy)
    if (official.some(rel => !safeImagePath(rel) || !manifest.files.some(file => file.name === `images/${rel}`))) invalid('备份缺少正式图片或包含非法图片引用')
    if (manifest.counts.images !== manifest.files.filter(file => file.name.startsWith('images/')).length) invalid('图片数量不匹配')
    checkCancelled(job.id)
    registerReadFunctions(copy)
    // Upgrade only the verified extracted copy; never bind it to the active catalog.
    // Calling for equal versions also rejects withdrawn development snapshots.
    try { migrateDatabase(copy) }
    catch (error) { invalid(`备份数据库升级失败：${(error as Error).message}`) }
    assertSchema(copy, target)
    const upgradedImages = referencedOfficialImages(copy)
    if (upgradedImages.some(rel => !safeImagePath(rel) || !manifest.files.some(file => file.name === `images/${rel}`))) invalid('升级后的资料库缺少正式图片')
    summary.counts = { ...counts(copy), images: manifest.counts.images }
    summary.roots = copy.prepare(ROOTS_SQL).all() as BackupSummary['roots']
    summary.unrootedResources = (copy.prepare("SELECT count(*) AS n FROM video_resources WHERE kind = 'local' AND root_id IS NULL").get() as { n: number }).n
    job.upgrade = manifest.schemaVersion < CURRENT_SCHEMA_VERSION ? { fromSchemaVersion: manifest.schemaVersion, toSchemaVersion: CURRENT_SCHEMA_VERSION } : undefined
    checkCancelled(job.id)
  } finally { copy.close() }
  fs.writeFileSync(path.join(jobDir(host, job.id), 'staged-path'), dir)
  job.summary = summary; job.phase = 'ready'; writeJob(host, job)
}
function staged(host: BackupHost, id: string): string { return fs.readFileSync(path.join(jobDir(host, id), 'staged-path'), 'utf8') }

function prepareRestore(host: BackupHost, job: StoredJob, db: Database.Database, mappings: BackupMapping[], omitUnrooted = false): void {
  if (!job.summary || job.phase !== 'ready') invalid('请先检查备份')
  if (job.summary.unrootedResources && !omitUnrooted) invalid('请明确确认仅保留无来源目录资源的资料')
  const roots = job.summary.roots
  if (mappings.length !== roots.length || new Set(mappings.map(x => x.sourceRootId)).size !== roots.length || mappings.some(x => !roots.some(r => r.id === x.sourceRootId))) invalid('请为每个来源目录选择目标，或明确选择仅保留资料')
  const mounts: Record<string, string> = {}
  const mapped: Array<{ sourceRootId: number; targetMountSelectionId: string }> = []
  for (const mapping of mappings) {
    if (mapping.target.kind === 'omit') continue
    const key = String(mapping.sourceRootId)
    if (mapping.target.kind === 'local') {
      if (host.mode !== 'local' || !path.isAbsolute(mapping.target.path) || !fs.statSync(mapping.target.path).isDirectory()) invalid('请选择有效的本机目录')
      mounts[key] = fs.realpathSync.native(mapping.target.path)
    } else mounts[key] = resolveMountSelectionPath(mapping.target.mountSelectionId, mapping.target.relativePath)
    mapped.push({ sourceRootId: mapping.sourceRootId, targetMountSelectionId: key })
  }
  const readyDb = path.join(jobDir(host, job.id), 'ready.db')
  fs.copyFileSync(path.join(staged(host, job.id), 'catalog/library.db'), readyDb)
  const copy = new Database(readyDb)
  let missing = 0
  let removed = 0
  try {
    const before = (copy.prepare("SELECT count(*) AS n FROM video_resources WHERE kind = 'local'").get() as { n: number }).n
    const disabled = new Set(roots.filter(r => mappings.some(m => m.sourceRootId === r.id && m.target.kind === 'omit')).map(r => r.libraryId))
    const unrooted = copy.prepare("SELECT DISTINCT library_id AS id FROM video_resources WHERE kind = 'local' AND root_id IS NULL").all() as Array<{ id: number }>
    for (const row of unrooted) disabled.add(row.id)
    applyMigrationTransforms(copy, mapped, mounts, job.summary.sourcePlatform, [...disabled])
    const resources = copy.prepare("SELECT v.library_id AS libraryId, v.locator, r.path AS rootPath FROM video_resources v JOIN media_library_roots r ON r.id = v.root_id WHERE v.kind = 'local'").all() as Array<{ libraryId: number; locator: string; rootPath: string }>
    removed = before - resources.length
    for (const resource of resources) {
      if (!fs.existsSync(resource.locator)) { missing++; disabled.add(resource.libraryId) }
      else {
        const relative = path.relative(fs.realpathSync.native(resource.rootPath), fs.realpathSync.native(resource.locator))
        if (relative.startsWith('..') || path.isAbsolute(relative)) invalid('资源通过符号链接超出所选目录')
      }
    }
    for (const id of disabled) copy.prepare('UPDATE media_library_configs SET remove_resource_less_memberships = 0 WHERE library_id = ?').run(id)
    stripBackupRuntime(copy)
    copy.pragma('wal_checkpoint(TRUNCATE)')
  } finally { copy.close() }
  job.mappings = mappings; job.targetStamp = stamp(db)
  job.preview = {
    digest: digestRequest([job.sha256, mappings, job.targetStamp]), targetCounts: counts(db), missingResources: missing,
    removedResources: removed, blockers: countPendingBlockers(db), automaticBackupPath: root(host)
  }
  writeJob(host, job)
}

/** New images never overwrite live paths. The only publication point is the database transaction. */
async function restore(host: BackupHost, job: StoredJob, db: Database.Database): Promise<void> {
  const protection: StoredJob = { id: randomUUID(), kind: 'backup', phase: 'snapshot', createdAt: new Date().toISOString(), bytes: 0, transferred: 0, catalogId: job.catalogId, epoch: job.epoch, owner: job.owner }
  job.phase = 'protecting'; job.automaticBackupId = protection.id; writeJob(host, job); writeJob(host, protection)
  try {
    await makeArchive(host, protection, db)
    await inspect(host, protection, db)
    protection.phase = 'completed'; writeJob(host, protection)
  } catch (error) {
    protection.phase = 'failed'; protection.error = toStructuredError(error).message
    hideIncompleteArchive(host, protection); writeJob(host, protection)
    throw error
  }
  checkCancelled(job.id)
  const identity = readCatalogIdentity(db)!
  const nextId = randomUUID()
  job.newCatalogId = nextId; job.phase = 'applying'; writeJob(host, job)
  const readyDb = path.join(jobDir(host, job.id), 'ready.db')
  const copy = new Database(readyDb)
  try {
    for (const mapping of job.mappings ?? []) {
      if (mapping.target.kind === 'omit') continue
      const current = mapping.target.kind === 'local' ? fs.realpathSync.native(mapping.target.path) : resolveMountSelectionPath(mapping.target.mountSelectionId, mapping.target.relativePath)
      const rootRow = copy.prepare('SELECT library_id, path FROM media_library_roots WHERE id=?').get(mapping.sourceRootId) as { library_id: number; path: string }
      if (current !== rootRow.path) throw structuredError('VERSION_CONFLICT', '目标资源目录已变化，请重新核对')
      if (host.mode === 'remote') {
        initializeJavdexRootMarker(current)
        markJavdexRootInitialized(rootRow.library_id, mapping.sourceRootId, copy)
      }
    }
    // Files may disappear while the user is reviewing. Never enable automatic deletion in that case.
    copy.prepare("SELECT library_id, locator FROM video_resources WHERE kind='local'").all().forEach(row => {
      const resource = row as { library_id: number; locator: string }
      if (!fs.existsSync(resource.locator)) copy.prepare('UPDATE media_library_configs SET remove_resource_less_memberships=0 WHERE library_id=?').run(resource.library_id)
    })
    const sourceImages = path.join(staged(host, job.id), 'images')
    const rels = walkOfficialImages(sourceImages)
    assertSpace(images(host), rels.reduce((n, rel) => n + fs.statSync(path.join(sourceImages, rel)).size, 0))
    for (const rel of rels) {
      const [sub, ...rest] = rel.split('/')
      const nextRel = `${sub}/restore-${job.id}/${rest.join('/')}`
      const dest = path.join(images(host), nextRel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(path.join(sourceImages, rel), dest)
      const fd = fs.openSync(dest, 'r+'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      syncDirectory(path.dirname(dest)); syncDirectory(path.join(images(host), sub))
      remapAssetPathOn(copy, rel, nextRel)
    }
    copy.pragma('wal_checkpoint(TRUNCATE)')
    // Every reused ID gets a generation newer than either catalog's previous entries.
    for (const table of ['videos', 'actresses', 'organizations', 'directors', 'series', 'playlists']) {
      const max = (on: Database.Database): number => (on.prepare(`SELECT coalesce(max(generation), 0) AS n FROM ${table}`).get() as { n: number }).n
      copy.prepare(`UPDATE ${table} SET generation = ?`).run(Math.max(max(copy), max(db)) + 1)
    }
    copy.pragma('wal_checkpoint(TRUNCATE)')
  } finally { copy.close() }
  const credentials = db.prepare('SELECT * FROM catalog_writer_credentials').all() as Array<Record<string, unknown>>
  const quote = (value: string): string => "'" + value.replace(/'/g, "''") + "'"
  const revoked = revokeAllPlayGrants(db)
  notifyPlayGrantsRevoked(revoked)
  db.pragma('synchronous = FULL')
  db.exec(`ATTACH DATABASE ${quote(readyDb)} AS backupsrc`)
  try {
    db.transaction(() => {
      copyAttachedCatalog(db, 'backupsrc')
      db.prepare('INSERT INTO catalog_identity (id, catalog_id, server_id, writer_epoch, frozen, created_at, updated_at) VALUES (1, ?, ?, ?, 1, ?, ?)').run(nextId, identity.serverId, identity.writerEpoch, new Date().toISOString(), new Date().toISOString())
      for (const row of credentials) {
        const columns = Object.keys(row)
        db.prepare(`INSERT INTO catalog_writer_credentials (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row))
      }
    })()
  } finally { db.exec('DETACH DATABASE backupsrc') }
  host.onRestored?.(nextId)
  job.phase = 'completed'
}

export function recoverBackupOperations(host: BackupHost, db: Database.Database): void {
  for (const job of jobs(host)) {
    if (!['snapshot', 'packing', 'protecting', 'applying', 'inspecting', 'recoveryRequired'].includes(job.phase)) continue
    if (running.has(job.id)) continue
    const identity = readCatalogIdentity(db)
    if (job.newCatalogId && job.newCatalogId === identity?.catalogId) {
      host.onRestored?.(job.newCatalogId!); job.phase = 'completed'
    } else { job.phase = 'failed'; job.error = '上次操作已中断，原资料库保持可用，请重新检查后重试'; hideIncompleteArchive(host, job) }
    if (identity?.catalogId === job.catalogId || identity?.catalogId === job.newCatalogId) setCatalogFrozen(false, db)
    writeJob(host, job)
  }
}
export function backupControl(host: BackupHost, database: Database.Database, raw: BackupRequest, owner = 'local'): BackupResponse {
  const input = backupRequestSchema.parse(raw)
  const identity = readCatalogIdentity(database)
  if (!identity) invalid('资料库尚未初始化')
  if (input.action === 'list') return { jobs: jobs(host).filter(x => x.owner === owner && !x.recordDeletedAt).map(publicJob).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }
  const existing = fs.existsSync(path.join(jobDir(host, input.id), 'job.json')) ? readJob(host, input.id) : null
  if (existing && (existing.owner !== owner || existing.epoch !== identity.writerEpoch)) throw structuredError('AUTH_REQUIRED', '备份任务不属于当前写入授权')
  let job: StoredJob
  if (input.action === 'create' || input.action === 'receive') {
    if (existing) {
      if ((input.action === 'create') !== (existing.kind === 'backup') || (input.action === 'receive' && (existing.bytes !== input.bytes || existing.sha256 !== input.sha256))) invalid('任务 ID 已用于其他备份')
      return { jobs: [publicJob(existing)] }
    }
    assertIdle(database, false)
    job = { id: input.id, kind: input.action === 'create' ? 'backup' : 'restore', phase: input.action === 'create' ? 'snapshot' : 'receiving', bytes: input.action === 'receive' ? input.bytes : 0, transferred: 0, sha256: input.action === 'receive' ? input.sha256 : undefined, createdAt: new Date().toISOString(), catalogId: identity.catalogId, epoch: identity.writerEpoch, owner }
    assertSpace(root(host), job.bytes * 2)
    writeJob(host, job)
  } else {
    if (!existing) invalid('备份任务不存在')
    job = existing
  }
  if (input.action === 'status' || input.action === 'receive') return { jobs: [publicJob(job)] }
  if (input.action === 'previewRemoval' || input.action === 'removeRecord') {
    if (running.has(job.id) || !['completed', 'failed', 'cancelled'].includes(job.phase)) invalid('请等待任务结束后删除记录；需要恢复处理的任务不能删除')
    const download = downloads.get(downloadKey(host, job.id))
    if (download && (download.active > 0 || download.until > Date.now())) invalid('备份正在下载或刚结束传输，请稍后重试')
    downloads.delete(downloadKey(host, job.id))
    const related = jobs(host).filter(other => other.automaticBackupId === job.id)
    const protectedByRestore = related.some(other => running.has(other.id) || !['completed', 'failed', 'cancelled'].includes(other.phase))
    const userDataPath = host.userDataPath ?? resolveLibraryUserDataPath()
    if (input.action === 'previewRemoval') {
      let artifacts: ReturnType<typeof inspectBackupArtifacts> | undefined
      let blockedReason = protectedByRestore ? '此自动备份仍被未结束的恢复任务使用，暂不能清理文件。' : undefined
      try { artifacts = inspectBackupArtifacts(userDataPath, job.id) } catch (error) { blockedReason = (error as Error).message }
      return { jobs: [publicJob(job)], removal: {
        digest: job.filesDeletionDigest ?? artifacts?.digest ?? digestRequest(job.id),
        bytes: artifacts?.bytes ?? 0, fileCount: artifacts?.fileCount ?? 0,
        location: artifacts?.location ?? root(host), host: host.mode,
        automaticBackup: related.length > 0, retainedAutomaticBackup: Boolean(job.automaticBackupId),
        cleanupStarted: Boolean(job.filesDeletionDigest && !job.filesDeletedAt), blockedReason
      } }
    }
    if (input.deleteFiles) {
      if (protectedByRestore) invalid('此自动备份仍被未结束的恢复任务使用，不能删除')
      if (!job.filesDeletedAt) {
        const artifacts = inspectBackupArtifacts(userDataPath, job.id)
        if (!input.digest || input.digest !== (job.filesDeletionDigest ?? artifacts.digest)) invalid('备份文件已变化，请重新核对删除范围')
        // Persist intent before unlinking. A failed/partial cleanup remains visible and retryable.
        job.filesDeletionDigest = input.digest; writeJob(host, job)
        try { removeBackupArtifacts(userDataPath, job.id) }
        catch (error) { throw new Error(`备份清理未完成，记录已保留，可重试：${(error as Error).message}`) }
        job.filesDeletedAt = new Date().toISOString()
      }
    } else if (job.filesDeletionDigest && !job.filesDeletedAt) invalid('上次文件清理尚未完成，请勾选清理文件后重试')
    if (!job.recordDeletedAt) job.recordDeletedAt = new Date().toISOString()
    writeJob(host, job)
    return { jobs: [] }
  }
  if (input.action === 'cancel') {
    if (['applying', 'recoveryRequired'].includes(job.phase)) invalid('正在提交恢复，不能取消')
    if (['completed', 'cancelled'].includes(job.phase)) return { jobs: [publicJob(job)] }
    if (running.has(job.id)) cancelled.add(job.id)
    else { job.phase = 'cancelled'; writeJob(host, job) }
    return { jobs: [publicJob(job)] }
  }
  if (input.action === 'restore' && job.phase === 'completed' && job.preview?.digest === input.digest) return { jobs: [publicJob(job)] }
  if (job.recordDeletedAt) invalid('此操作记录已删除，请创建新任务')
  if (job.catalogId !== identity.catalogId) throw structuredError('CATALOG_MISMATCH', '目标资料库已变化，请重新创建恢复任务')
  if (input.action === 'preview') { assertIdle(database, false); prepareRestore(host, job, database, input.mappings, input.omitUnrooted); return { jobs: [publicJob(job)] } }
  if (running.has(job.id)) return { jobs: [publicJob(job)] }
  const creating = input.action === 'create' || input.action === 'confirmMissingImages'
  if (input.action === 'confirmMissingImages') {
    if (job.kind !== 'backup') invalid('只能确认备份来源中的缺失图片')
    if (job.phase === 'completed' && job.acceptedMissingDigest === input.digest) return { jobs: [publicJob(job)] }
    if (job.phase !== 'awaitingImages' || job.missingImages?.digest !== input.digest) invalid('缺失图片清单已变化，请重新核对')
    assertIdle(database, false)
    job.acceptedMissingDigest = input.digest; job.phase = 'snapshot'; job.error = undefined
    writeJob(host, job)
  }
  if (input.action === 'restore') {
    if (job.phase === 'completed') return { jobs: [publicJob(job)] }
    if (job.phase !== 'ready' || !job.preview || job.preview.digest !== input.digest || job.targetStamp !== stamp(database)) throw structuredError('VERSION_CONFLICT', '资料库或恢复预览已变化，请重新核对')
    assertIdle(database, true)
  }
  if (input.action === 'inspect' && (job.kind !== 'restore' || !['receiving', 'failed'].includes(job.phase))) invalid('当前任务不能重新检查')
  const freezing = creating || input.action === 'restore'
  const lease = freezing ? maintenanceTaskGate.tryAcquire('resource-maintenance') : null
  if (freezing && !lease) {
    if (creating) { job.phase = 'failed'; job.error = '已有扫描或维护任务正在运行'; writeJob(host, job) }
    throw structuredError('MAINTENANCE_BUSY', '已有扫描或维护任务正在运行')
  }
  if (freezing) { setCatalogFrozen(true, database); maintenanceActive = true }
  if (input.action === 'inspect') { job.phase = 'inspecting'; writeJob(host, job) }
  running.add(job.id)
  void (async () => {
    try {
      const work = async (): Promise<void> => {
      if (creating) { await makeArchive(host, job, database); await inspect(host, job, database); job.phase = 'completed' }
      else if (input.action === 'inspect') await inspect(host, job, database)
      else if (input.action === 'restore') await restore(host, job, database)
      }
      if (freezing) await mediaAssetStore.runExclusiveRelocation(work)
      else await work()
    } catch (error) {
      const committed = job.newCatalogId && readCatalogIdentity(database)?.catalogId === job.newCatalogId
      job.phase = committed ? 'recoveryRequired' : cancelled.has(job.id) ? 'cancelled' : 'failed'
      job.error = toStructuredError(error).message
      if (creating && error instanceof MissingBackupImagesError && !cancelled.has(job.id)) {
        job.phase = 'awaitingImages'; job.error = undefined
        job.missingImages = { paths: error.paths, digest: digestRequest(error.paths) }
      }
      try { hideIncompleteArchive(host, job) } catch { /* Keep the original failure; downloads stay disabled. */ }
    } finally {
      try {
        if (freezing && job.phase !== 'recoveryRequired') setCatalogFrozen(false, database)
        writeJob(host, job)
      } catch (error) {
        job.phase = 'recoveryRequired'; job.error = toStructuredError(error).message
        // Fail closed if the durable completion record or unfreeze could not be saved.
        try { if (freezing) setCatalogFrozen(true, database); writeJob(host, job) } catch { /* Startup replays the last durable journal. */ }
      } finally {
        running.delete(job.id); cancelled.delete(job.id); lease?.release()
        if (freezing && job.phase !== 'recoveryRequired') maintenanceActive = false
      }
    }
  })()
  return { jobs: [publicJob(job)] }
}

export function backupFile(host: BackupHost, id: string, owner: string): string {
  const job = readJob(host, id)
  if (job.owner !== owner || job.kind !== 'backup' || job.phase !== 'completed' || job.filesDeletionDigest || job.filesDeletedAt) throw structuredError('AUTH_REQUIRED', '备份尚未完成或无权访问')
  return archive(host, id)
}
export function writeBackupChunk(host: BackupHost, id: string, owner: string, offset: number, data: Buffer): number {
  const job = readJob(host, id)
  if (job.owner !== owner || job.phase !== 'receiving') throw structuredError('AUTH_REQUIRED', '上传任务无效')
  if (!Number.isSafeInteger(offset) || offset < 0 || data.length > BACKUP_CHUNK_BYTES || offset + data.length > job.bytes) invalid('上传分块大小或位置无效')
  const dest = archive(host, id)
  if (offset < job.transferred) {
    const fd = fs.openSync(dest, 'r'); const prior = Buffer.alloc(data.length)
    try { fs.readSync(fd, prior, 0, prior.length, offset) } finally { fs.closeSync(fd) }
    if (offset + data.length > job.transferred || !prior.equals(data)) invalid('重复分块内容不一致')
    return job.transferred
  }
  if (offset !== job.transferred) invalid('分块偏移不一致，请查询任务后续传')
  assertSpace(jobDir(host, id), data.length)
  const fd = fs.openSync(dest, fs.existsSync(dest) ? 'r+' : 'w', 0o600)
  try { fs.writeSync(fd, data, 0, data.length, offset); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  job.transferred += data.length; writeJob(host, job)
  return job.transferred
}

/** Hold files through the HTTP stream and briefly between resumable chunk requests. */
export function beginBackupDownload(host: BackupHost, id: string, owner: string): { file: string; release: () => void } {
  const file = backupFile(host, id, owner)
  const key = downloadKey(host, id)
  const lease = downloads.get(key) ?? { active: 0, until: 0 }
  lease.active++; downloads.set(key, lease)
  let released = false
  return { file, release() {
    if (released) return
    released = true; lease.active--; lease.until = Date.now() + 30000
    const timer = setTimeout(() => { if (lease.active === 0 && lease.until <= Date.now()) downloads.delete(key) }, 30001)
    timer.unref()
  } }
}
