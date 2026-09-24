import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { CatalogTaskSnapshot } from '@shared/protocol/tasks'
import type {
  MigrationControlInput,
  MigrationAbandonInput,
  MigrationEnableInput,
  MigrationPreview,
  MigrationPreviewInput,
  MigrationStatus,
  RootMapping
} from '@shared/protocol/migration'
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from '@library/db/migrations'
import { MANAGE_PROTOCOL_VERSION } from '@shared/protocol/identity'
import { MIGRATION_PACKAGE_MAX_BYTES } from '@shared/protocol/limits'
import { ASSET_MEDIA_SUBDIRS, resolveMediaAssetsRoot } from '@library/assetStoragePaths'
import {
  resolveLibraryMediaMounts,
  resolveLibraryUserDataPath
} from '@library/runtime/host'
import { structuredError } from '@shared/protocol/errors'
import { decryptBlob, isEncryptedBlob } from '@library/assetCrypto'
import { getPathAlias } from '@library/assetPathAliases'
import { getDb } from '@library/db/database'
import { digestEquals, digestRequest } from './catalogSecrets'
import { readCatalogIdentity, setCatalogFrozen } from './catalogIdentity'
import {
  deleteCatalogSetting,
  listCatalogSettingKeys,
  readCatalogSetting,
  writeCatalogSetting
} from './catalogSettings'
import { MIGRATION_AUTH_KEY } from './catalogMigrationAuth'
import { putCatalogTask } from './catalogTasks'
import {
  MIGRATION_FINAL_PREFIX,
  MIGRATION_STATE_KEY,
  MIGRATION_TARGET_INTENT_PREFIX,
  catalogLooksEmpty,
  type StoredMigrationState
} from './catalogMigrationState'
import { computeMigrationPreview } from './catalogMigrationPreview'
import { applyMigrationTransforms, stripExportSecrets } from './catalogMigrationApply'
import {
  MIGRATION_FORMAT_VERSION,
  packMigrationArchive,
  posixRel,
  sha256File,
  unpackMigrationArchive,
  walkFiles,
  type MigrationManifest
} from './catalogMigrationArchive'

const ENC_MAGIC = Buffer.from('AVPK\x01')

export interface CatalogMigrationHost {
  appVersion: string
  userDataPath?: string
  imagesDir?: string
  mediaMounts?: Readonly<Record<string, string>>
  now?: () => Date
}

function hostPaths(host: CatalogMigrationHost): {
  userDataPath: string
  imagesDir: string
  mediaMounts: Readonly<Record<string, string>>
} {
  const userDataPath = host.userDataPath ?? resolveLibraryUserDataPath()
  return {
    userDataPath,
    imagesDir: host.imagesDir ?? resolveMediaAssetsRoot(),
    mediaMounts: host.mediaMounts ?? resolveLibraryMediaMounts()
  }
}

export function openIsolatedCatalog(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const connection = new Database(dbPath)
  connection.pragma('journal_mode = WAL')
  connection.pragma('foreign_keys = ON')
  migrateDatabase(connection)
  return connection
}

function readState(database: Database.Database): StoredMigrationState | null {
  return normalizeStoredMigration(readCatalogSetting<StoredMigrationState | null>(MIGRATION_STATE_KEY, null, database))
}

/** Preserve the local freeze when reading a pre-offline migration record. */
function normalizeStoredMigration(state: StoredMigrationState | null): StoredMigrationState | null {
  if (!state || state.phase) return state
  const legacy = state as StoredMigrationState & {
    sourcePhase?: string; targetPhase?: string; allowEnableAt?: string
  }
  const { sourcePhase, targetPhase, allowEnableAt: _obsoletePermission, ...local } = legacy
  const prior = local.role === 'source' ? sourcePhase : targetPhase
  const phase = prior === 'enableAuthorized' ? 'frozen' : prior
  if (!phase || !['prepare', 'frozen', 'ready', 'enabled', 'abandoned'].includes(phase)) {
    throw structuredError('RECOVERY_REQUIRED', '旧迁移状态无法识别，请检查本端资料库')
  }
  return { ...local, phase: phase as StoredMigrationState['phase'] }
}

function migrationStatus(state: StoredMigrationState): MigrationStatus {
  return { migrationId: state.migrationId, role: state.role, phase: state.phase, digest: state.digest }
}

function writeState(state: StoredMigrationState, database: Database.Database): void {
  writeCatalogSetting(MIGRATION_STATE_KEY, state, database)
}

function readFinal(migrationId: string, database: Database.Database): StoredMigrationState | null {
  return normalizeStoredMigration(readCatalogSetting<StoredMigrationState | null>(
    `${MIGRATION_FINAL_PREFIX}${migrationId}`, null, database
  ))
}

function writeFinal(state: StoredMigrationState, database: Database.Database): void {
  writeCatalogSetting(`${MIGRATION_FINAL_PREFIX}${state.migrationId}`, state, database)
}

function countEncryptedAssets(imagesDir: string): number {
  if (!fs.existsSync(imagesDir)) return 0
  let count = 0
  for (const rel of walkOfficialImages(imagesDir)) {
    const abs = path.join(imagesDir, rel)
    const fd = fs.openSync(abs, 'r')
    try {
      const buf = Buffer.alloc(ENC_MAGIC.length)
      const read = fs.readSync(fd, buf, 0, buf.length, 0)
      if (read >= ENC_MAGIC.length && buf.equals(ENC_MAGIC)) count += 1
    } finally {
      fs.closeSync(fd)
    }
  }
  return count
}

function walkOfficialImages(imagesDir: string): string[] {
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

function availableBytes(dir: string): number {
  fs.mkdirSync(dir, { recursive: true })
  const stat = fs.statfsSync(dir)
  return Number(stat.bavail) * Number(stat.bsize)
}

function digestImages(imagesDir: string, rels: string[]): { count: number; digest: string } {
  const payload = rels.map((rel) => {
    const abs = path.join(imagesDir, rel)
    const stat = fs.statSync(abs)
    return { rel, size: stat.size, sha256: sha256File(abs) }
  })
  return { count: rels.length, digest: digestRequest(payload) }
}

function packagePath(userDataPath: string, migrationId: string): string {
  return path.join(userDataPath, 'migration-packages', `${migrationId}.tar.gz`)
}

function stagingDir(userDataPath: string, migrationId: string): string {
  return path.join(userDataPath, 'migration-staging', migrationId)
}

function copyOfficialImages(fromDir: string, toDir: string): string[] {
  const copied: string[] = []
  for (const rel of walkOfficialImages(fromDir)) {
    const dest = path.join(toDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(fromDir, rel), dest)
    copied.push(rel)
  }
  return copied
}

function removeCopiedOfficialImages(imagesDir: string, rels: readonly string[]): void {
  for (const rel of rels) {
    try {
      fs.unlinkSync(path.join(imagesDir, rel))
    } catch {
      // Best-effort: EACCES on the directory may also block cleanup.
    }
  }
}

function snapshotLiveCatalog(database: Database.Database, destPath: string): void {
  if (!database.name || database.name === ':memory:') {
    throw structuredError('UNSUPPORTED_CAPABILITY', '内存资料库不能启用迁入')
  }
  database.pragma('wal_checkpoint(TRUNCATE)')
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.copyFileSync(database.name, destPath)
}

function restoreCatalogFromSnapshot(database: Database.Database, snapshotPath: string): void {
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

function remapAssetPathOn(
  database: Database.Database,
  fromRel: string,
  toRel: string
): void {
  database.prepare('UPDATE videos SET cover_path = ? WHERE cover_path = ?').run(toRel, fromRel)
  database.prepare('UPDATE videos SET poster_path = ? WHERE poster_path = ?').run(toRel, fromRel)
  database.prepare('UPDATE actresses SET avatar_path = ? WHERE avatar_path = ?').run(toRel, fromRel)
  database
    .prepare('UPDATE actresses SET avatar_source_path = ? WHERE avatar_source_path = ?')
    .run(toRel, fromRel)
  database.prepare('UPDATE actresses SET poster_path = ? WHERE poster_path = ?').run(toRel, fromRel)
  database.prepare('UPDATE playlists SET cover_path = ? WHERE cover_path = ?').run(toRel, fromRel)
  database.prepare('UPDATE video_assets SET local_path = ? WHERE local_path = ?').run(toRel, fromRel)
  database
    .prepare('UPDATE actress_gallery_assets SET local_path = ? WHERE local_path = ?')
    .run(toRel, fromRel)
}

/**
 * Decrypt official images in a staging/export tree using the source LibraryHost
 * key (hostname + username + userDataPath) and source path aliases. Does not
 * mutate the live source imagesDir or alias journal.
 */
function decryptStagedOfficialImages(
  stagedImages: string,
  database: Database.Database
): void {
  for (const rel of walkOfficialImages(stagedImages)) {
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

function listUserTables(database: Database.Database): string[] {
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

function copyAttachedCatalog(dest: Database.Database, alias: string): void {
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
    dest.exec(`INSERT INTO "${name}" SELECT * FROM ${alias}."${name}"`)
  }
  dest.pragma('defer_foreign_keys = OFF')
}

export function previewCatalogMigration(
  input: MigrationPreviewInput,
  host: CatalogMigrationHost,
  database: Database.Database = getDb()
): MigrationPreview {
  const identity = readCatalogIdentity(database)
  if (!identity) throw structuredError('INSTANCE_MISMATCH', '资料库身份尚未初始化')
  const existing = readState(database)
  if (identity.frozen) throw structuredError('MAINTENANCE_BUSY', '当前资料库已冻结，请先处理本端迁移')
  if (existing && !['prepare', 'abandoned', 'enabled'].includes(existing.phase)) {
    throw structuredError('MAINTENANCE_BUSY', '已有迁移尚未结束')
  }
  const { imagesDir, mediaMounts } = hostPaths(host)
  if (catalogLooksEmpty(database)) {
    for (const mapping of input.mappings) {
      if (!mediaMounts[mapping.targetMountSelectionId]) {
        throw structuredError('INVALID_INPUT', '目标挂载不存在，不能降级为不映射', {
          field: 'targetMountSelectionId'
        })
      }
    }
    return {
      migrationId: existing?.migrationId ?? randomUUID(),
      sourceServerId: identity.serverId,
      sourceCatalogId: identity.catalogId,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      appVersion: host.appVersion,
      localResourceRemovals: 0,
      strmConversions: 0,
      strmConflicts: [],
      omittedRoots: [],
      autoCleanupDisabledLibraryIds: [],
      pendingBlockers: [],
      digest: digestRequest({ mappings: input.mappings, role: 'target' })
    }
  }
  const preview = computeMigrationPreview(
    input.mappings,
    {
      appVersion: host.appVersion,
      encryptedAssetCount: countEncryptedAssets(imagesDir),
      migrationId: existing?.role === 'source' && existing.phase === 'prepare'
        ? existing.migrationId
        : undefined
    },
    database
  )
  writeState(
    {
      migrationId: preview.migrationId,
      role: 'source',
      phase: 'prepare',
      digest: preview.digest,
      mappings: input.mappings,
      preview,
      sourcePlatform: process.platform,
      sourceServerId: identity.serverId,
      sourceCatalogId: identity.catalogId,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      appVersion: host.appVersion,
      packageRel: null
    },
    database
  )
  return preview
}

function requireState(
  input: MigrationControlInput,
  database: Database.Database
): StoredMigrationState {
  const state = readState(database)
  if (!state || state.migrationId !== input.migrationId) {
    throw structuredError('INVALID_INPUT', '迁移编号不匹配')
  }
  if (!digestEquals(state.digest, input.digest)) {
    throw structuredError('VERSION_CONFLICT', '迁移摘要已变化，请重新预览')
  }
  return state
}

async function exportSourcePackage(
  state: StoredMigrationState,
  host: CatalogMigrationHost,
  database: Database.Database
): Promise<string> {
  const { userDataPath, imagesDir } = hostPaths(host)
  const dbPath = database.name
  if (!dbPath || dbPath === ':memory:') {
    throw structuredError('UNSUPPORTED_CAPABILITY', '内存资料库不能导出迁移包')
  }
  const imageRelsLive = walkOfficialImages(imagesDir)
  const estimated =
    fs.statSync(dbPath).size +
    imageRelsLive.reduce((sum, rel) => sum + fs.statSync(path.join(imagesDir, rel)).size, 0)
  if (availableBytes(userDataPath) < estimated * 2) {
    throw structuredError('LIMIT_EXCEEDED', '磁盘空间不足导出迁移数据')
  }
  database.pragma('wal_checkpoint(TRUNCATE)')
  const workDir = path.join(userDataPath, 'migration-work', state.migrationId)
  fs.rmSync(workDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(workDir, 'catalog'), { recursive: true })
  fs.mkdirSync(path.join(workDir, 'images'), { recursive: true })
  const copiedDb = path.join(workDir, 'catalog', 'library.db')
  fs.copyFileSync(dbPath, copiedDb)
  copyOfficialImages(imagesDir, path.join(workDir, 'images'))
  const copy = openIsolatedCatalog(copiedDb)
  try {
    stripExportSecrets(copy)
    decryptStagedOfficialImages(path.join(workDir, 'images'), copy)
    copy.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    copy.close()
  }
  const imageRels = walkOfficialImages(path.join(workDir, 'images'))
  const imageDigest = digestImages(path.join(workDir, 'images'), imageRels)
  const dataDigest = sha256File(copiedDb)
  const videoCount = (
    database.prepare('SELECT COUNT(*) AS n FROM videos').get() as { n: number }
  ).n
  const manifest: MigrationManifest = {
    formatVersion: MIGRATION_FORMAT_VERSION,
    protocolVersion: MANAGE_PROTOCOL_VERSION,
    appVersion: host.appVersion,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    sourcePlatform: state.sourcePlatform,
    sourceServerId: state.sourceServerId,
    sourceCatalogId: state.sourceCatalogId,
    migrationId: state.migrationId,
    previewDigest: state.digest,
    mappings: state.mappings,
    autoCleanupDisabledLibraryIds: state.preview.autoCleanupDisabledLibraryIds,
    dataCount: videoCount,
    dataDigest,
    imageCount: imageDigest.count,
    imageDigest: imageDigest.digest,
    mappingDigest: digestRequest(state.mappings),
    createdAt: (host.now ?? (() => new Date()))().toISOString()
  }
  const manifestPath = path.join(workDir, 'manifest.json')
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const members = [
    { name: 'manifest.json', absPath: manifestPath },
    { name: 'catalog/library.db', absPath: copiedDb },
    ...imageRels.map((rel) => ({
      name: `images/${rel}`,
      absPath: path.join(workDir, 'images', rel)
    }))
  ]
  const dest = packagePath(userDataPath, state.migrationId)
  await packMigrationArchive(members, dest)
  return dest
}

async function importTargetPackage(
  input: MigrationControlInput,
  host: CatalogMigrationHost,
  database: Database.Database
): Promise<StoredMigrationState> {
  const { userDataPath, mediaMounts } = hostPaths(host)
  const identity = readCatalogIdentity(database)
  if (!identity) throw structuredError('INSTANCE_MISMATCH', '资料库身份尚未初始化')
  if (!catalogLooksEmpty(database)) {
    throw structuredError('INVALID_INPUT', '只能迁入空目标资料库')
  }
  if (identity.writerEpoch > 0) {
    throw structuredError('AUTH_REQUIRED', '已认主的目标不能接收迁移')
  }
  const archive = packagePath(userDataPath, input.migrationId)
  if (!fs.existsSync(archive)) {
    throw structuredError('INVALID_INPUT', '目标尚未暂存迁移包')
  }
  const dest = stagingDir(userDataPath, input.migrationId)
  fs.rmSync(dest, { recursive: true, force: true })
  await unpackMigrationArchive(archive, dest, { availableBytes: availableBytes(userDataPath) })
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8')
  ) as MigrationManifest
  if (manifest.formatVersion !== MIGRATION_FORMAT_VERSION) {
    throw structuredError('VERSION_MISMATCH', '迁移包格式版本不支持')
  }
  if (manifest.appVersion !== host.appVersion) {
    throw structuredError('VERSION_MISMATCH', '桌面与服务器应用版本不一致')
  }
  if (manifest.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw structuredError('VERSION_MISMATCH', '迁移包 schema 版本不一致')
  }
  if (manifest.migrationId !== input.migrationId) {
    throw structuredError('INVALID_INPUT', '迁移编号与数据包不一致')
  }
  if (!digestEquals(manifest.previewDigest, input.digest)) {
    throw structuredError('VERSION_CONFLICT', '迁移摘要与数据包不一致')
  }
  const stagedDbPath = path.join(dest, 'catalog', 'library.db')
  if (sha256File(stagedDbPath) !== manifest.dataDigest) {
    throw structuredError('VERSION_CONFLICT', '数据包校验失败')
  }
  const stagedImages = path.join(dest, 'images')
  const imageRels = walkOfficialImages(stagedImages)
  const imageDigest = digestImages(stagedImages, imageRels)
  if (imageDigest.count !== manifest.imageCount || imageDigest.digest !== manifest.imageDigest) {
    throw structuredError('VERSION_CONFLICT', '图片包校验失败')
  }
  if (countEncryptedAssets(stagedImages) > 0) {
    throw structuredError('INVALID_INPUT', '加密存量阻止迁入')
  }
  const staged = openIsolatedCatalog(stagedDbPath)
  try {
    applyMigrationTransforms(
      staged,
      manifest.mappings,
      mediaMounts,
      manifest.sourcePlatform,
      manifest.autoCleanupDisabledLibraryIds
    )
    staged.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    staged.close()
  }
  copyOfficialImages(stagedImages, path.join(dest, 'applied-images'))
  return {
    migrationId: manifest.migrationId,
    role: 'target',
    phase: 'ready',
    digest: manifest.previewDigest,
    mappings: manifest.mappings,
    preview: {
      migrationId: manifest.migrationId,
      sourceServerId: manifest.sourceServerId,
      sourceCatalogId: manifest.sourceCatalogId,
      schemaVersion: manifest.schemaVersion,
      appVersion: manifest.appVersion,
      localResourceRemovals: 0,
      strmConversions: 0,
      strmConflicts: [],
      omittedRoots: [],
      autoCleanupDisabledLibraryIds: manifest.autoCleanupDisabledLibraryIds,
      pendingBlockers: [],
      digest: manifest.previewDigest
    },
    sourcePlatform: manifest.sourcePlatform,
    sourceServerId: manifest.sourceServerId,
    sourceCatalogId: manifest.sourceCatalogId,
    schemaVersion: manifest.schemaVersion,
    appVersion: manifest.appVersion,
    packageRel: path.relative(userDataPath, archive)
  }
}

export async function startCatalogMigration(
  input: MigrationControlInput,
  host: CatalogMigrationHost,
  database: Database.Database = getDb()
): Promise<CatalogTaskSnapshot | MigrationPreview> {
  const final = readFinal(input.migrationId, database)
  if (final) throw structuredError('INVALID_INPUT', '该迁移已结束，请创建新的导出/导入操作')
  if (readCatalogIdentity(database)?.frozen) {
    throw structuredError('MAINTENANCE_BUSY', '当前迁移尚未结束，请查看本端状态，不要重复开始')
  }
  if (catalogLooksEmpty(database)) {
    return startTargetMigration(input, host, database)
  }
  const identity = readCatalogIdentity(database)
  if (!identity) throw structuredError('INSTANCE_MISMATCH', '资料库身份尚未初始化')
  const state = requireState(input, database)
  const { imagesDir } = hostPaths(host)
  if (state.role === 'source') {
    const recomputed = computeMigrationPreview(
      state.mappings,
      { appVersion: host.appVersion, encryptedAssetCount: countEncryptedAssets(imagesDir) },
      database
    )
    if (recomputed.digest !== state.digest) {
      throw structuredError('VERSION_CONFLICT', '冻结后影响已变化，请重新预览')
    }
    if (recomputed.pendingBlockers.length > 0 || recomputed.strmConflicts.length > 0) {
      throw structuredError('INVALID_INPUT', '迁移预检未通过')
    }
    setCatalogFrozen(true, database)
    const taskId = state.taskId ?? randomUUID()
    const snapshot: CatalogTaskSnapshot = {
      owner: 'catalog',
      taskId,
      catalogId: identity.catalogId,
      kind: 'migration.start',
      state: 'running',
      taskRevision: 1,
      progressSeq: 0,
      label: '冻结并导出迁移包'
    }
    putCatalogTask(snapshot, {}, database)
    try {
      const packageFile = await exportSourcePackage(state, host, database)
      const next: StoredMigrationState = {
        ...state,
        phase: 'frozen',
        packageRel: path.relative(hostPaths(host).userDataPath, packageFile),
        taskId
      }
      writeState(next, database)
      const done: CatalogTaskSnapshot = {
        ...snapshot,
        state: 'succeeded',
        taskRevision: 2,
        progressSeq: 1
      }
      putCatalogTask(done, {}, database)
      return done
    } catch (error) {
      setCatalogFrozen(false, database)
      putCatalogTask(
        {
          ...snapshot,
          state: 'failed',
          taskRevision: 2,
          progressSeq: 1,
          errorCode: 'RECOVERY_REQUIRED'
        },
        {},
        database
      )
      throw error
    }
  }

  throw structuredError('INVALID_INPUT', '源端迁移状态无效')
}

async function startTargetMigration(
  input: MigrationControlInput,
  host: CatalogMigrationHost,
  database: Database.Database
): Promise<CatalogTaskSnapshot> {
  const identity = readCatalogIdentity(database)
  if (!identity) throw structuredError('INSTANCE_MISMATCH', '资料库身份尚未初始化')
  const intentKey = `${MIGRATION_TARGET_INTENT_PREFIX}${input.migrationId}`
  writeCatalogSetting(intentKey, {
    migrationId: input.migrationId,
    digest: input.digest,
    createdAt: new Date().toISOString()
  }, database)
  setCatalogFrozen(true, database)
  try {
    const next = await importTargetPackage(input, host, database)
    writeState(next, database)
    deleteCatalogSetting(intentKey, database)
    const snapshot: CatalogTaskSnapshot = {
      owner: 'catalog',
      taskId: randomUUID(),
      catalogId: identity.catalogId,
      kind: 'migration.start',
      state: 'succeeded',
      taskRevision: 1,
      progressSeq: 1,
      label: '校验迁移暂存'
    }
    putCatalogTask(snapshot, {}, database)
    return snapshot
  } catch (error) {
    setCatalogFrozen(false, database)
    deleteCatalogSetting(intentKey, database)
    throw error
  }
}

export function statusCatalogMigration(
  input: { migrationId: string },
  database: Database.Database = getDb()
): MigrationStatus {
  const live = readState(database)
  const final = readFinal(input.migrationId, database)
  const state = live?.migrationId === input.migrationId ? live : final
  if (!state) throw structuredError('INVALID_INPUT', '迁移不存在')
  return migrationStatus(state)
}


export function enableCatalogMigration(
  input: MigrationEnableInput,
  host: CatalogMigrationHost,
  database: Database.Database = getDb()
): MigrationStatus {
  if (input.confirmSourceStopped !== true) {
    throw structuredError('INVALID_INPUT', '启用导入前必须确认源库已停止使用', { field: 'confirmSourceStopped' })
  }
  const identity = readCatalogIdentity(database)
  if (!identity) throw structuredError('INSTANCE_MISMATCH', '资料库身份尚未初始化')
  const existingFinal = readFinal(input.migrationId, database)
  if (existingFinal && !digestEquals(existingFinal.digest, input.digest)) {
    throw structuredError('VERSION_CONFLICT', '导入摘要与已完成记录不一致')
  }
  if (existingFinal?.phase === 'abandoned') {
    throw structuredError('AUTH_REQUIRED', '该迁移已放弃，不能再次启用该导入')
  }
  if (existingFinal?.phase === 'enabled') {
    return migrationStatus(existingFinal)
  }
  const { userDataPath, imagesDir } = hostPaths(host)
  const workStaging = stagingDir(userDataPath, input.migrationId)
  const stagedDb = path.join(workStaging, 'catalog', 'library.db')
  const appliedImages = path.join(workStaging, 'applied-images')
  const snapshotPath = path.join(workStaging, 'pre-enable.db')
  if (!fs.existsSync(stagedDb)) {
    throw structuredError('RECOVERY_REQUIRED', '迁移暂存不完整，不能发布')
  }
  const savedAuth = readCatalogSetting<unknown>(MIGRATION_AUTH_KEY, null, database)
  snapshotLiveCatalog(database, snapshotPath)
  let justEnabled = false
  let copiedRels: string[] = []
  database.exec(`ATTACH DATABASE ${sqlLiteral(stagedDb)} AS migsrc`)
  try {
    const result = database.transaction(() => {
      const final = readFinal(input.migrationId, database)
      if (final?.phase === 'abandoned') {
        throw structuredError('AUTH_REQUIRED', '该迁移已放弃，不能再次启用该导入')
      }
      if (final?.phase === 'enabled') {
        return migrationStatus(final)
      }
      const state = requireState(input, database)
      if (state.role !== 'target') {
        throw structuredError('INVALID_INPUT', '只有目标可以启用迁入结果')
      }
      if (state.phase === 'enabled') {
        return statusCatalogMigration({ migrationId: input.migrationId }, database)
      }
      if (state.phase !== 'ready') {
        throw structuredError('INVALID_INPUT', '目标尚未就绪')
      }
      if (!catalogLooksEmpty(database) || identity.writerEpoch > 0) {
        throw structuredError('INVALID_INPUT', '只能启用到未认主的空目标资料库')
      }
      copyAttachedCatalog(database, 'migsrc')
      const newCatalogId = randomUUID()
      const now = (host.now ?? (() => new Date()))().toISOString()
      database
        .prepare(
          `UPDATE catalog_identity
              SET catalog_id = ?, server_id = ?, writer_epoch = 0, frozen = 0, updated_at = ?
            WHERE id = 1`
        )
        .run(newCatalogId, identity.serverId, now)
      if (savedAuth) writeCatalogSetting(MIGRATION_AUTH_KEY, savedAuth, database)
      const next: StoredMigrationState = {
        ...state,
        phase: 'enabled',
        newCatalogId,
        enabledAt: now
      }
      writeState(next, database)
      writeFinal(next, database)
      justEnabled = true
      return migrationStatus(next)
    })()
    if (result.phase === 'enabled' && fs.existsSync(appliedImages)) {
      try {
        copiedRels = copyOfficialImages(appliedImages, imagesDir)
      } catch (error) {
        if (justEnabled) {
          try {
            restoreCatalogFromSnapshot(database, snapshotPath)
          } catch {
            // Prefer the original copy failure; rollback is best-effort after that.
          }
          removeCopiedOfficialImages(imagesDir, copiedRels)
        }
        throw error
      }
    }
    try {
      fs.unlinkSync(snapshotPath)
    } catch {
      // Snapshot is only a rollback aid.
    }
    return result
  } finally {
    try {
      database.exec('DETACH DATABASE migsrc')
    } catch {
      // Detach after a rolled-back attach is optional.
    }
  }
}

export function abandonCatalogMigration(
  input: MigrationAbandonInput,
  host: CatalogMigrationHost,
  database: Database.Database = getDb()
): MigrationStatus {
  const identity = readCatalogIdentity(database)
  if (!identity) throw structuredError('INSTANCE_MISMATCH', '资料库身份尚未初始化')
  return database.transaction(() => {
    const final = readFinal(input.migrationId, database)
    if (final && !digestEquals(final.digest, input.digest)) {
      throw structuredError('VERSION_CONFLICT', '迁移摘要与已完成记录不一致')
    }
    if (final?.phase === 'enabled') {
      return migrationStatus(final)
    }
    if (final?.phase === 'abandoned') {
      return migrationStatus(final)
    }
    const state = requireState(input, database)
    if ((state.role === 'source' && state.phase === 'prepare' && identity.frozen) ||
      listCatalogSettingKeys(MIGRATION_TARGET_INTENT_PREFIX, database).length > 0) {
      throw structuredError('MAINTENANCE_BUSY', '导出或导入仍在执行，请等待本端操作完成')
    }
    if (state.role === 'source' && state.phase === 'frozen' && input.confirmTargetStopped !== true) {
      throw structuredError('INVALID_INPUT', '恢复源库前必须确认目标已停用；不支持双库并行写入', { field: 'confirmTargetStopped' })
    }
    const now = (host.now ?? (() => new Date()))().toISOString()
    const next: StoredMigrationState = { ...state, phase: 'abandoned', abandonedAt: now }
    writeState(next, database)
    writeFinal(next, database)
    setCatalogFrozen(false, database)
    if (state.role === 'target') {
      const { userDataPath } = hostPaths(host)
      fs.rmSync(stagingDir(userDataPath, state.migrationId), { recursive: true, force: true })
    }
    return migrationStatus(next)
  })()
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function recoverCatalogMigration(database: Database.Database = getDb()): void {
  const state = readState(database)
  const identity = readCatalogIdentity(database)
  for (const key of listCatalogSettingKeys(MIGRATION_TARGET_INTENT_PREFIX, database)) {
    const intent = readCatalogSetting<{ migrationId?: string } | null>(key, null, database)
    const matches = Boolean(intent?.migrationId && state?.migrationId === intent.migrationId)
    const targetReady = matches && state?.role === 'target' && state.phase === 'ready'
    // Only an intent belonging to the current migration (or an otherwise
    // state-less empty target) may release the freeze. A stale key must not
    // unfreeze an unrelated source/target migration.
    if ((!state || matches) && !targetReady && identity?.frozen) {
      setCatalogFrozen(false, database)
    }
    deleteCatalogSetting(key, database)
  }
  if (!state) return
  if (state.role === 'source' && state.phase === 'prepare' && identity?.frozen) {
    setCatalogFrozen(false, database)
    return
  }
  if (state.role === 'target' && state.phase !== 'enabled' && state.phase !== 'abandoned') {
    if (identity && !identity.frozen) setCatalogFrozen(true, database)
  }
}

export function stageMigrationPackageFile(
  migrationId: string,
  sourceFile: string,
  host: CatalogMigrationHost
): string {
  const { userDataPath } = hostPaths(host)
  const dest = packagePath(userDataPath, migrationId)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(sourceFile, dest)
  return dest
}

export function writeMigrationPackageBytes(
  migrationId: string,
  body: Buffer,
  host: CatalogMigrationHost
): { ok: true; bytes: number } {
  if (body.length > MIGRATION_PACKAGE_MAX_BYTES) {
    throw structuredError('LIMIT_EXCEEDED', '迁移包超过大小上限', {
      limit: MIGRATION_PACKAGE_MAX_BYTES,
      actual: body.length
    })
  }
  const dest = packagePath(hostPaths(host).userDataPath, migrationId)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, body)
  return { ok: true, bytes: body.length }
}

export function migrationPackagePath(migrationId: string, host: CatalogMigrationHost): string {
  return packagePath(hostPaths(host).userDataPath, migrationId)
}

export function readStoredMigrationMappings(database: Database.Database = getDb()): RootMapping[] {
  return readState(database)?.mappings ?? []
}
