import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, test } from 'node:test'
import { backupControl, backupFile, beginBackupDownload, writeBackupChunk, recoverBackupOperations, type BackupHost } from './catalogBackup'
import { openIsolatedCatalog } from './catalogMigration'
import { ensureCatalogIdentity, readCatalogIdentity } from './catalogIdentity'
import { insertTestVideoWithFile } from '@library/db/testVideoFixtures'
import { sha256File, unpackMigrationArchive, packMigrationArchive } from './catalogMigrationArchive'
import { BACKUP_CHUNK_BYTES, type BackupJob } from '@shared/protocol/backup'
import { authenticateWriter, issueOneTimeToken, claimWriter } from './catalogWriter'
import { configureLibraryHost } from '@library/runtime/host'
import { encryptPlain, isEncryptedBlob, resetAssetKeyCacheForTests } from '@library/assetCrypto'
import { setPathAlias } from '@library/assetPathAliases'
import { digestToken } from './catalogSecrets'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { CURRENT_SCHEMA_VERSION } from '@library/db/migrations'
import { CATALOG_TASK_SCHEMA_SQL, CATALOG_IMAGE_UPLOAD_SCHEMA_SQL } from '@library/db/schema'

const cleanups: Array<() => void> = []
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean() })

test('abrupt process termination before and after publication recovers a complete catalog', async t => {
  for (const stage of ['protecting', 'images', 'beforeCommit', 'committed']) {
    await t.test(stage, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-backup-crash-'))
      cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
      const child = spawnSync(process.execPath, [
        '--require', './scripts/register-test-paths.cjs', '--import', 'tsx',
        '--import', './scripts/register-library-test-host.ts',
        'packages/library/src/catalog/__fixtures__/backupCrash.ts', dir, stage
      ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000 })
      assert.equal(child.status, 23, child.stderr || child.error?.message)
      const root = path.join(dir, 'target')
      const db = openIsolatedCatalog(path.join(root, 'library.db'))
      try {
        const host: BackupHost = { mode: 'local', appVersion: 'test', userDataPath: root, imagesDir: path.join(root, 'images') }
        recoverBackupOperations(host, db)
        const { id } = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8')) as { id: string }
        const job = backupControl(host, db, { action: 'status', id }).jobs[0]
        assert.equal(job.phase, stage === 'committed' ? 'completed' : 'failed')
        assert.equal(readCatalogIdentity(db)?.frozen, false)
        const row = db.prepare('SELECT code, cover_path FROM videos').get() as { code: string; cover_path: string }
        assert.equal(row.code, stage === 'committed' ? 'source' : 'target')
        assert.equal(fs.readFileSync(path.join(host.imagesDir!, row.cover_path), 'utf8'), row.code)
        assert.equal(fs.readFileSync(path.join(dir, 'source/images/covers/original.png'), 'utf8'), 'source')
      } finally { db.close() }
    })
  }
})
function fixture(mode: 'local' | 'remote' = 'local') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-backup-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const db = openIsolatedCatalog(path.join(dir, 'library.db'))
  cleanups.push(() => db.close())
  ensureCatalogIdentity({ serverId: mode === 'remote' ? randomUUID() : null }, db)
  const imagesDir = path.join(dir, 'images'); fs.mkdirSync(path.join(imagesDir, 'covers'), { recursive: true })
  const host: BackupHost = { mode, appVersion: 'test', userDataPath: dir, imagesDir }
  const request = (input: Parameters<typeof backupControl>[2]) => backupControl(host, db, input).jobs[0]
  return { host, db, dir, request }
}
async function wait(f: ReturnType<typeof fixture>, id: string, phase: BackupJob['phase']): Promise<BackupJob> {
  for (let n = 0; n < 500; n++) {
    const job = f.request({ action: 'status', id })
    if (job.phase === phase) return job
    if (job.phase === 'failed' || job.phase === 'recoveryRequired') throw new Error(job.error)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timeout waiting for ${phase}`)
}
async function exported(f: ReturnType<typeof fixture>) {
  const id = randomUUID(); f.request({ action: 'create', id })
  const job = await wait(f, id, 'completed')
  return { job, file: backupFile(f.host, id, 'local') }
}
async function received(target: ReturnType<typeof fixture>, file: string) {
  const id = randomUUID(); const bytes = fs.readFileSync(file)
  target.request({ action: 'receive', id, bytes: bytes.length, sha256: sha256File(file) })
  for (let offset = 0; offset < bytes.length; offset += BACKUP_CHUNK_BYTES) writeBackupChunk(target.host, id, 'local', offset, bytes.subarray(offset, offset + BACKUP_CHUNK_BYTES))
  target.request({ action: 'inspect', id })
  await wait(target, id, 'ready')
  return id
}

// Synthetic format-1 historical fixtures: remove the exact structures added by V18/V19.
async function historicalBackup(source: ReturnType<typeof fixture>, version: number, edit?: (db: Database.Database, manifest: Record<string, unknown>) => void) {
  const { file } = await exported(source)
  const dir = path.join(source.dir, randomUUID()); const members = await unpackMigrationArchive(file, dir)
  const manifestFile = path.join(dir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const databaseFile = path.join(dir, 'catalog/library.db'); const db = new Database(databaseFile)
  try {
    const removeTables = (schema: string): void => {
      const added = new Database(':memory:')
      try {
        added.exec(schema)
        for (const row of added.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>) db.exec(`DROP TABLE ${row.name}`)
      } finally { added.close() }
    }
    if (version < 19) removeTables(CATALOG_TASK_SCHEMA_SQL)
    if (version < 18) {
      removeTables(CATALOG_IMAGE_UPLOAD_SCHEMA_SQL)
      for (const table of ['actresses', 'organizations', 'directors', 'series', 'playlists']) {
        db.exec(`ALTER TABLE ${table} DROP COLUMN generation`)
        if (table !== 'actresses') db.exec(`ALTER TABLE ${table} DROP COLUMN revision`)
      }
    }
    db.pragma(`user_version = ${version}`)
    manifest.schemaVersion = version; manifest.appVersion = '0.7.1'
    edit?.(db, manifest)
  } finally { db.close() }
  const databaseEntry = manifest.files.find((entry: { name: string }) => entry.name === 'catalog/library.db')
  databaseEntry.bytes = fs.statSync(databaseFile).size; databaseEntry.sha256 = sha256File(databaseFile)
  fs.writeFileSync(manifestFile, JSON.stringify(manifest))
  const output = path.join(source.dir, `${randomUUID()}.backup`)
  await packMigrationArchive(members.files.map(name => ({ name, absPath: path.join(dir, name) })), output)
  return output
}

test('older format-1 backups upgrade isolated copies through existing migrations and restore locally and remotely', async t => {
  for (const version of [17, 18, CURRENT_SCHEMA_VERSION]) for (const mode of ['local', 'remote'] as const) await t.test(`${version} -> ${CURRENT_SCHEMA_VERSION}, ${mode}`, async () => {
    const source = fixture(); const target = fixture(mode)
    target.host.appVersion = '0.8.0-beta.1'
    const video = insertTestVideoWithFile(source.db, { code: 'OLD-BACKUP', filePath: '/source/old.avi', libraryId: 1 })
    source.db.prepare('UPDATE videos SET cover_path = ? WHERE id = ?').run('covers/test.png', video.videoId)
    fs.writeFileSync(path.join(source.host.imagesDir!, 'covers/test.png'), 'image')
    source.db.prepare('INSERT INTO playlists (name) VALUES (?)').run('保留清单')
    const file = await historicalBackup(source, version, (_db, manifest) => { manifest.optionalDescription = '未知可选字段不会影响格式 1 的读取' })
    const checksum = sha256File(file); const oldIdentity = readCatalogIdentity(target.db)!
    const id = await received(target, file); const job = target.request({ action: 'status', id })
    assert.equal(job.summary!.appVersion, '0.7.1')
    assert.equal(job.summary!.schemaVersion, version)
    assert.equal(job.upgrade?.toSchemaVersion, version < CURRENT_SCHEMA_VERSION ? CURRENT_SCHEMA_VERSION : undefined)
    assert.equal((target.db.prepare('SELECT count(*) AS n FROM videos').get() as { n: number }).n, 0)
    const preview = target.request({ action: 'preview', id, mappings: [], omitUnrooted: true }).preview!
    target.request({ action: 'restore', id, digest: preview.digest }); await wait(target, id, 'completed')
    assert.equal((target.db.prepare('SELECT code FROM videos').get() as { code: string }).code, 'OLD-BACKUP')
    assert.equal((target.db.prepare('SELECT name FROM playlists').get() as { name: string }).name, '保留清单')
    const cover = (target.db.prepare('SELECT cover_path FROM videos').get() as { cover_path: string }).cover_path
    assert.equal(fs.readFileSync(path.join(target.host.imagesDir!, cover), 'utf8'), 'image')
    assert.equal(readCatalogIdentity(target.db)!.serverId, oldIdentity.serverId)
    assert.equal(sha256File(file), checksum)
    assert.equal(source.db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
  })
})

test('incompatible or inconsistent old backups fail before changing the target', async t => {
  const cases: Array<{ name: string; edit: (db: Database.Database, manifest: Record<string, unknown>) => void; error: RegExp }> = [
    { name: 'newer app', edit: (_db, m) => { m.appVersion = '0.8.0' }, error: /更高版本/ },
    { name: 'newer schema', edit: (_db, m) => { m.schemaVersion = CURRENT_SCHEMA_VERSION + 1 }, error: /数据库版本高于/ },
    { name: 'unknown format', edit: (_db, m) => { m.formatVersion = 2 }, error: /formatVersion/ },
    { name: 'version mismatch', edit: db => { db.pragma('user_version = 17') }, error: /实际版本/ },
    { name: 'invalid summary', edit: (_db, m) => { (m.counts as { videos: number }).videos = 999 }, error: /摘要/ },
    { name: 'unsupported old schema', edit: (_db, m) => { m.schemaVersion = 16 }, error: /过旧/ },
    { name: 'migration failure', edit: db => { db.exec('CREATE TABLE catalog_tasks (wrong TEXT)') }, error: /column/ },
    { name: 'withdrawn schema', edit: db => { db.exec('DROP TABLE catalog_image_uploads') }, error: /unreleased/ }
  ]
  for (const item of cases) await t.test(item.name, async () => {
    const source = fixture(); const target = fixture(); target.host.appVersion = '0.8.0-beta.1'
    const file = await historicalBackup(source, 18, item.edit); const checksum = sha256File(file)
    const before = readCatalogIdentity(target.db)
    await assert.rejects(() => received(target, file), item.error)
    assert.deepEqual(readCatalogIdentity(target.db), before)
    assert.equal(sha256File(file), checksum)
    assert.equal((target.db.prepare('SELECT count(*) AS n FROM videos').get() as { n: number }).n, 0)
  })
})
test('backup does not freeze the source permanently; overwrite preserves target ownership and publishes images with the database', async () => {
  const source = fixture(); const target = fixture('remote')
  const video = insertTestVideoWithFile(source.db, { code: 'TEST-1', title: 'Source', filePath: path.join(source.dir, 'test.avi'), libraryId: 1 })
  source.db.prepare('UPDATE videos SET cover_path = ? WHERE id = ?').run('covers/原图.png', video.videoId)
  fs.writeFileSync(path.join(source.host.imagesDir!, 'covers/原图.png'), 'original-image')
  insertTestVideoWithFile(target.db, { code: 'OLD-1', title: 'Old target', filePath: path.join(target.dir, 'old.mp4'), libraryId: 1 })
  const token = issueOneTimeToken('initialBind', {}, target.db)
  const secret = 'a'.repeat(64)
  claimWriter({ kind: 'initialBind', oneTimeToken: token.oneTimeToken, candidate: { claimId: randomUUID(), secretDigest: digestToken(secret) } }, {}, target.db)
  const oldIdentity = readCatalogIdentity(target.db)!
  const { file } = await exported(source)
  assert.equal(readCatalogIdentity(source.db)?.frozen, false)
  const id = await received(target, file)
  const preview = target.request({ action: 'preview', id, mappings: [], omitUnrooted: true }).preview!
  target.request({ action: 'restore', id, digest: preview.digest })
  const result = await wait(target, id, 'completed')
  assert.notEqual(result.newCatalogId, oldIdentity.catalogId)
  assert.equal(target.request({ action: 'restore', id, digest: preview.digest }).phase, 'completed')
  assert.throws(() => target.request({ action: 'inspect', id }))
  assert.equal(readCatalogIdentity(target.db)?.frozen, false)
  const newIdentity = readCatalogIdentity(target.db)!
  authenticateWriter(secret, { serverId: oldIdentity.serverId!, catalogId: newIdentity.catalogId, writerEpoch: oldIdentity.writerEpoch }, target.db)
  const row = target.db.prepare('SELECT code, cover_path FROM videos').get() as { code: string; cover_path: string }
  assert.equal(row.code, 'TEST-1')
  assert.match(row.cover_path, /restore-/)
  assert.equal(fs.readFileSync(path.join(target.host.imagesDir!, row.cover_path), 'utf8'), 'original-image')
  assert.equal(fs.readFileSync(path.join(source.host.imagesDir!, 'covers/原图.png'), 'utf8'), 'original-image')
  assert.ok(fs.existsSync(backupFile(target.host, result.automaticBackupId!, 'local')))
  assert.equal((source.db.prepare('SELECT count(*) AS n FROM videos').get() as { n: number }).n, 1)
})
test('chunk retries are idempotent and reject inconsistent bytes, offsets and other owners', () => {
  const f = fixture(); const id = randomUUID()
  f.request({ action: 'receive', id, bytes: 8, sha256: 'a'.repeat(64) })
  assert.equal(writeBackupChunk(f.host, id, 'local', 0, Buffer.from('1234')), 4)
  assert.equal(writeBackupChunk(f.host, id, 'local', 0, Buffer.from('1234')), 4)
  assert.throws(() => writeBackupChunk(f.host, id, 'local', 0, Buffer.from('xxxx')))
  assert.throws(() => writeBackupChunk(f.host, id, 'local', 6, Buffer.from('12')))
  assert.throws(() => writeBackupChunk(f.host, id, 'stranger', 4, Buffer.from('5678')))
})
test('changed target invalidates preview before any restore write', async () => {
  const source = fixture(); const target = fixture()
  const { file } = await exported(source); const id = await received(target, file)
  const preview = target.request({ action: 'preview', id, mappings: [], omitUnrooted: true }).preview!
  target.db.prepare("UPDATE media_libraries SET name = 'changed' WHERE id = 1").run()
  assert.throws(() => target.request({ action: 'restore', id, digest: preview.digest }), /./)
  assert.equal(readCatalogIdentity(target.db)?.frozen, false)
})
test('restart completes a committed restore journal before releasing maintenance', () => {
  const f = fixture(); const id = randomUUID(); const nextId = randomUUID()
  const before = readCatalogIdentity(f.db)!
  f.request({ action: 'receive', id, bytes: 4, sha256: 'a'.repeat(64) })
  const journal = path.join(f.dir, 'backups', 'operations', id, 'job.json')
  fs.writeFileSync(journal, JSON.stringify({ ...JSON.parse(fs.readFileSync(journal, 'utf8')), phase: 'applying', newCatalogId: nextId }))
  f.db.prepare('UPDATE catalog_identity SET catalog_id = ?, frozen = 1').run(nextId)
  recoverBackupOperations(f.host, f.db)
  assert.equal(f.request({ action: 'status', id }).phase, 'completed')
  assert.equal(readCatalogIdentity(f.db)?.frozen, false)
  assert.notEqual(before.catalogId, nextId)
})


test('unrooted resources require explicit omission and disable automatic cleanup without deleting videos', async () => {
  const source = fixture(); const target = fixture()
  insertTestVideoWithFile(source.db, { code: 'NO-ROOT', filePath: path.join(source.dir, 'clip.avi'), libraryId: 1 })
  source.db.prepare('UPDATE media_library_configs SET remove_resource_less_memberships = 1').run()
  const { file } = await exported(source); const id = await received(target, file)
  assert.throws(() => target.request({ action: 'preview', id, mappings: [] }))
  const preview = target.request({ action: 'preview', id, mappings: [], omitUnrooted: true }).preview!
  assert.equal(preview.removedResources, 1)
  target.request({ action: 'restore', id, digest: preview.digest }); await wait(target, id, 'completed')
  assert.equal((target.db.prepare('SELECT count(*) AS n FROM videos').get() as { n: number }).n, 1)
  assert.equal((target.db.prepare('SELECT remove_resource_less_memberships AS n FROM media_library_configs').get() as { n: number }).n, 0)
})

test('mapping handles Chinese/space paths, missing resources, and duplicate target directories', async () => {
  const source = fixture(); const target = fixture()
  const first = insertTestVideoWithFile(source.db, { code: 'MAP-1', filePath: 'C:\\来源 目录\\电影.avi', libraryId: 1 })
  source.db.prepare("INSERT INTO media_library_roots (id, library_id, path, normalized_path) VALUES (1,1,?,?)").run('C:\\来源 目录', 'source-one')
  source.db.prepare('UPDATE video_resources SET root_id=1 WHERE video_id=?').run(first.videoId)
  source.db.prepare("INSERT INTO media_library_roots (id, library_id, path, normalized_path) VALUES (2,1,?,?)").run('D:\\第二目录', 'source-two')
  // The fixture runs on Windows. This is also exercised with win32 sourcePlatform in Linux Docker smoke.
  const { file } = await exported(source); const id = await received(target, file)
  const dir = path.join(target.dir, '资源 子目录'); fs.mkdirSync(dir)
  const mapping = { sourceRootId: 1, target: { kind: 'local' as const, path: dir } }
  assert.throws(() => target.request({ action: 'preview', id, mappings: [mapping] }))
  assert.throws(() => target.request({ action: 'preview', id, mappings: [mapping, { ...mapping, sourceRootId: 2 }] }))
  if (process.platform !== 'win32') return
  const preview = target.request({ action: 'preview', id, mappings: [mapping, { sourceRootId: 2, target: { kind: 'omit' } }] }).preview!
  assert.equal(preview.missingResources, 1)
  assert.equal(preview.removedResources, 0)
  target.request({ action: 'restore', id, digest: preview.digest }); await wait(target, id, 'completed')
  // Mapping canonicalizes the existing directory, including Windows 8.3 aliases.
  // The missing resource itself cannot be passed to realpath.
  assert.equal((target.db.prepare('SELECT locator FROM video_resources').get() as { locator: string }).locator, path.join(fs.realpathSync.native(dir), '电影.avi'))
})

test('encrypted official images and classification covers export in plaintext without changing source files', async () => {
  const source = fixture(); const target = fixture()
  configureLibraryHost({ userDataPath: () => source.dir, assets: { assetEncryption: () => true, mediaAssetsPath: () => source.host.imagesDir! } })
  resetAssetKeyCacheForTests()
  const rel = 'covers/encrypted.avpk'; const plain = Buffer.from('portable original image')
  const encrypted = encryptPlain(plain, '.png')
  fs.writeFileSync(path.join(source.host.imagesDir!, rel), encrypted)
  setPathAlias(rel, 'covers/解密图片.png')
  source.db.prepare('INSERT INTO directors (main_name, image_path) VALUES (?,?)').run('导演', rel)
  const { file } = await exported(source)
  assert.ok(isEncryptedBlob(fs.readFileSync(path.join(source.host.imagesDir!, rel))))
  resetAssetKeyCacheForTests()
  const id = await received(target, file)
  const preview = target.request({ action: 'preview', id, mappings: [] }).preview!
  target.request({ action: 'restore', id, digest: preview.digest }); await wait(target, id, 'completed')
  const restored = (target.db.prepare('SELECT image_path FROM directors').get() as { image_path: string }).image_path
  assert.deepEqual(fs.readFileSync(path.join(target.host.imagesDir!, restored)), plain)
})

test('tampered manifest is rejected and target remains writable', async () => {
  const source = fixture(); const target = fixture()
  const { file } = await exported(source)
  const unpack = path.join(source.dir, 'tamper'); const members = await unpackMigrationArchive(file, unpack)
  const manifestPath = path.join(unpack, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); manifest.counts.videos = 999
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))
  const tampered = path.join(source.dir, 'tampered.backup')
  await packMigrationArchive(members.files.map(name => ({ name, absPath: path.join(unpack, name) })), tampered)
  await assert.rejects(() => received(target, tampered), /摘要/)
  assert.equal(readCatalogIdentity(target.db)?.frozen, false)
})

test('failed image preparation keeps complete old database and verified automatic backup', async () => {
  const source = fixture(); const target = fixture()
  const video = insertTestVideoWithFile(source.db, { code: 'NEW', filePath: '/new.avi', libraryId: 1 })
  source.db.prepare("UPDATE videos SET cover_path='covers/new.png' WHERE id=?").run(video.videoId)
  fs.writeFileSync(path.join(source.host.imagesDir!, 'covers/new.png'), 'image')
  insertTestVideoWithFile(target.db, { code: 'OLD', filePath: '/old.avi', libraryId: 1 })
  const { file } = await exported(source); const id = await received(target, file)
  const preview = target.request({ action: 'preview', id, mappings: [], omitUnrooted: true }).preview!
  const badDir = path.join(target.dir, 'not-a-directory'); fs.writeFileSync(badDir, '')
  target.host.imagesDir = badDir
  target.request({ action: 'restore', id, digest: preview.digest })
  await assert.rejects(() => wait(target, id, 'completed'))
  assert.equal((target.db.prepare('SELECT code FROM videos').get() as { code: string }).code, 'OLD')
  assert.equal(readCatalogIdentity(target.db)?.frozen, false)
  assert.ok(fs.existsSync(backupFile(target.host, target.request({ action: 'status', id }).automaticBackupId!, 'local')))
})

test('isolated local exporter releases SQLite write lock and leaves source unfrozen', async () => {
  const f = fixture(); f.host.isolatedSource = true
  const { file } = await exported(f)
  assert.ok(fs.existsSync(file))
  assert.equal(readCatalogIdentity(f.db)?.frozen, false)
  f.db.exec('BEGIN IMMEDIATE; ROLLBACK;')
})


test('disk space preflight and cancellation leave the source writable without publishing a backup', async () => {
  const f = fixture()
  const statfs = fs.statfsSync
  fs.statfsSync = (() => ({ ...statfs(f.dir), bavail: 0, bsize: 4096 })) as unknown as typeof fs.statfsSync
  try {
    assert.throws(() => f.request({ action: 'create', id: randomUUID() }), error => (error as { code?: string }).code === 'LIMIT_EXCEEDED')
    assert.equal(readCatalogIdentity(f.db)?.frozen, false)
  } finally { fs.statfsSync = statfs }
  const id = randomUUID()
  f.request({ action: 'create', id }); f.request({ action: 'cancel', id })
  await wait(f, id, 'cancelled')
  assert.equal(readCatalogIdentity(f.db)?.frozen, false)
  assert.throws(() => backupFile(f.host, id, 'local'))
  f.db.exec('BEGIN IMMEDIATE; ROLLBACK;')
})


test('automatic backup failure stops overwrite and leaves no running protection task', async () => {
  const source = fixture(); const target = fixture()
  const video = insertTestVideoWithFile(target.db, { code: 'OLD', filePath: '/old.avi', libraryId: 1 })
  target.db.prepare("UPDATE videos SET cover_path='covers/missing.png' WHERE id=?").run(video.videoId)
  const { file } = await exported(source); const id = await received(target, file)
  const preview = target.request({ action: 'preview', id, mappings: [] }).preview!
  target.request({ action: 'restore', id, digest: preview.digest })
  await assert.rejects(() => wait(target, id, 'completed'), /缺少.*图片/)
  const job = target.request({ action: 'status', id })
  assert.equal(target.request({ action: 'status', id: job.automaticBackupId! }).phase, 'failed')
  assert.equal((target.db.prepare('SELECT code FROM videos').get() as { code: string }).code, 'OLD')
  assert.equal(readCatalogIdentity(target.db)?.frozen, false)
})

test('record deletion is persistent, owner-scoped and keeps backup files and restore receipts', async () => {
  const source = fixture(); const target = fixture('remote')
  const { job, file } = await exported(source); const checksum = sha256File(file)
  assert.throws(() => backupControl(source.host, source.db, { action: 'removeRecord', id: job.id }, 'another-writer'))
  source.request({ action: 'removeRecord', id: job.id })
  assert.deepEqual(backupControl(source.host, source.db, { action: 'list' }).jobs, [])
  source.request({ action: 'removeRecord', id: job.id })
  recoverBackupOperations(source.host, source.db)
  assert.deepEqual(backupControl(source.host, source.db, { action: 'list' }).jobs, [])
  assert.equal(sha256File(backupFile(source.host, job.id, 'local')), checksum)
  const id = await received(target, file)
  assert.throws(() => target.request({ action: 'removeRecord', id }), { message: /任务结束/ })
  const preview = target.request({ action: 'preview', id, mappings: [] }).preview!
  target.request({ action: 'restore', id, digest: preview.digest }); const completed = await wait(target, id, 'completed')
  target.request({ action: 'removeRecord', id })
  assert.equal(target.request({ action: 'restore', id, digest: preview.digest }).phase, 'completed')
  assert.ok(fs.existsSync(backupFile(target.host, completed.automaticBackupId!, 'local')))
  assert.equal(backupControl(target.host, target.db, { action: 'list' }).jobs.some(job => job.id === id), false)
})

test('unfinished records cannot be removed, while cancelled records can', () => {
  const f = fixture(); const id = randomUUID()
  f.request({ action: 'receive', id, bytes: 8, sha256: 'a'.repeat(64) })
  assert.throws(() => f.request({ action: 'removeRecord', id }), { message: /任务结束/ })
  f.request({ action: 'cancel', id }); f.request({ action: 'removeRecord', id })
  assert.deepEqual(backupControl(f.host, f.db, { action: 'list' }).jobs, [])
})

test('missing images need explicit confirmation, survive archive inspection as warnings, and never change the source', async () => {
  const f = fixture(); const target = fixture()
  const video = insertTestVideoWithFile(f.db, { code: 'MISSING', filePath: '/test.avi', libraryId: 1 })
  f.db.prepare("UPDATE videos SET cover_path='covers/缺失.png' WHERE id=?").run(video.videoId)
  f.db.prepare("INSERT INTO video_assets (video_id,type,local_path,remote_url) VALUES (?, 'sample', 'samples/missing.jpg', 'https://example.com/sample.jpg')").run(video.videoId)
  const id = randomUUID(); f.request({ action: 'create', id })
  const pending = await wait(f, id, 'awaitingImages')
  assert.deepEqual(pending.missingImages?.paths, ['covers/缺失.png', 'samples/missing.jpg'])
  assert.equal(readCatalogIdentity(f.db)?.frozen, false)
  assert.throws(() => backupFile(f.host, id, 'local'))
  assert.throws(() => f.request({ action: 'confirmMissingImages', id, digest: '0'.repeat(64) }))
  f.request({ action: 'confirmMissingImages', id, digest: pending.missingImages!.digest })
  const completed = await wait(f, id, 'completed')
  assert.deepEqual(completed.summary?.missingImages, pending.missingImages!.paths)
  assert.equal((f.db.prepare('SELECT cover_path FROM videos').get() as { cover_path: string }).cover_path, 'covers/缺失.png')
  const restoreId = await received(target, backupFile(f.host, id, 'local'))
  assert.deepEqual(target.request({ action: 'status', id: restoreId }).summary?.missingImages, pending.missingImages!.paths)
  const preview = target.request({ action: 'preview', id: restoreId, mappings: [], omitUnrooted: true }).preview!
  target.request({ action: 'restore', id: restoreId, digest: preview.digest })
  await wait(target, restoreId, 'completed')
  assert.equal((target.db.prepare('SELECT cover_path FROM videos').get() as { cover_path: null }).cover_path, null)
  assert.deepEqual(target.db.prepare('SELECT local_path,remote_url FROM video_assets').get(), { local_path: null, remote_url: 'https://example.com/sample.jpg' })
})

test('newly missing images require renewed confirmation; cancelling preflight releases the catalog', async () => {
  const f = fixture()
  const video = insertTestVideoWithFile(f.db, { code: 'CHANGE', filePath: '/test.avi', libraryId: 1 })
  f.db.prepare("UPDATE videos SET cover_path='covers/missing.png' WHERE id=?").run(video.videoId)
  const id = randomUUID(); f.request({ action: 'create', id })
  const first = await wait(f, id, 'awaitingImages')
  f.db.prepare("UPDATE videos SET poster_path='covers/new.png' WHERE id=?").run(video.videoId)
  f.request({ action: 'confirmMissingImages', id, digest: first.missingImages!.digest })
  const next = await wait(f, id, 'awaitingImages')
  assert.equal(next.missingImages!.paths.length, 2)
  assert.notEqual(next.missingImages!.digest, first.missingImages!.digest)
  f.request({ action: 'cancel', id })
  assert.equal(f.request({ action: 'status', id }).phase, 'cancelled')
  assert.equal(readCatalogIdentity(f.db)?.frozen, false)
})

test('export reports real stages and counters and handles cancellation at image checkpoints', async () => {
  const f = fixture()
  const video = insertTestVideoWithFile(f.db, { code: 'PROGRESS', filePath: '/test.avi', libraryId: 1 })
  f.db.prepare("UPDATE videos SET cover_path='covers/original.png' WHERE id=?").run(video.videoId)
  fs.writeFileSync(path.join(f.host.imagesDir!, 'covers/original.png'), 'original')
  const updates: NonNullable<BackupJob['progress']>[] = []
  f.host.onProgress = job => { if (job.progress) updates.push({ ...job.progress }) }
  await exported(f)
  for (const stage of ['checking', 'database', 'copying', 'decrypting', 'paths', 'checksums', 'packing']) {
    assert.ok(updates.some(update => update.stage === stage), stage)
  }
  assert.ok(updates.some(update => update.stage === 'copying' && update.total === 1 && update.completed === 1))
  const id = randomUUID()
  f.host.onProgress = job => {
    if (job.progress?.stage === 'copying') f.request({ action: 'cancel', id })
  }
  f.request({ action: 'create', id })
  await wait(f, id, 'cancelled')
  assert.equal(readCatalogIdentity(f.db)?.frozen, false)
  assert.equal(fs.readFileSync(path.join(f.host.imagesDir!, 'covers/original.png'), 'utf8'), 'original')
  assert.throws(() => backupFile(f.host, id, 'local'))
})


test('confirmed cleanup removes only managed files, preserves the receipt, and is idempotent on both hosts', async t => {
  for (const mode of ['local', 'remote'] as const) await t.test(mode, async () => {
    const f = fixture(mode)
    const { job, file } = await exported(f)
    const savedCopy = path.join(f.dir, '用户另存 备份.javdex-backup')
    fs.copyFileSync(file, savedCopy)
    const sourceHash = sha256File(savedCopy)
    const plan = backupControl(f.host, f.db, { action: 'previewRemoval', id: job.id }).removal!
    assert.ok(plan.bytes > fs.statSync(file).size, 'includes staging database and files')
    assert.ok(plan.fileCount > 1)
    assert.equal(plan.host, mode)
    assert.throws(() => f.request({ action: 'removeRecord', id: job.id, deleteFiles: true }), { message: /重新核对/ })
    const input = { action: 'removeRecord' as const, id: job.id, deleteFiles: true, digest: plan.digest }
    f.request(input); f.request(input)
    assert.equal(fs.existsSync(file), false)
    assert.equal(sha256File(savedCopy), sourceHash)
    const journal = path.join(f.dir, 'backups/operations', job.id, 'job.json')
    assert.ok(JSON.parse(fs.readFileSync(journal, 'utf8')).filesDeletedAt)
    assert.deepEqual(fs.readdirSync(path.dirname(journal)), ['job.json'])
    assert.throws(() => backupFile(f.host, job.id, 'local'))
    recoverBackupOperations(f.host, f.db)
    assert.equal(backupControl(f.host, f.db, { action: 'list' }).jobs.length, 0)
  })
})

test('restore record cleanup retains the source archive, protective backup and completed restore receipt', async () => {
  const source = fixture(); const target = fixture('remote')
  const { file } = await exported(source)
  const id = await received(target, file)
  const impact = target.request({ action: 'preview', id, mappings: [] }).preview!
  target.request({ action: 'restore', id, digest: impact.digest })
  const result = await wait(target, id, 'completed')
  const plan = backupControl(target.host, target.db, { action: 'previewRemoval', id }).removal!
  assert.equal(plan.retainedAutomaticBackup, true)
  target.request({ action: 'removeRecord', id, deleteFiles: true, digest: plan.digest })
  assert.ok(fs.existsSync(file))
  assert.ok(fs.existsSync(backupFile(target.host, result.automaticBackupId!, 'local')))
  assert.equal(target.request({ action: 'restore', id, digest: impact.digest }).phase, 'completed')
  const protection = backupControl(target.host, target.db, { action: 'previewRemoval', id: result.automaticBackupId! }).removal!
  assert.equal(protection.automaticBackup, true)
})

test('cleanup validates its preview, refuses active downloads and protects unfinished restore dependencies', async () => {
  const f = fixture(); const { job, file } = await exported(f)
  const plan = backupControl(f.host, f.db, { action: 'previewRemoval', id: job.id }).removal!
  fs.writeFileSync(`${file}.partial`, 'new data')
  assert.throws(() => f.request({ action: 'removeRecord', id: job.id, deleteFiles: true, digest: plan.digest }), { message: /已变化/ })
  const lease = beginBackupDownload(f.host, job.id, 'local')
  try { assert.throws(() => f.request({ action: 'removeRecord', id: job.id, deleteFiles: true, digest: plan.digest }), { message: /下载/ }) }
  finally { lease.release() }

  const other = fixture(); const protectedJob = await exported(other)
  const restoreId = randomUUID()
  other.request({ action: 'receive', id: restoreId, bytes: 4, sha256: 'a'.repeat(64) })
  const journal = path.join(other.dir, 'backups/operations', restoreId, 'job.json')
  const restore = JSON.parse(fs.readFileSync(journal, 'utf8'))
  fs.writeFileSync(journal, JSON.stringify({ ...restore, automaticBackupId: protectedJob.job.id, phase: 'recoveryRequired' }))
  const protection = backupControl(other.host, other.db, { action: 'previewRemoval', id: protectedJob.job.id }).removal!
  assert.match(protection.blockedReason!, /恢复任务/)
  assert.throws(() => other.request({ action: 'removeRecord', id: protectedJob.job.id, deleteFiles: true, digest: protection.digest }), { message: /恢复任务/ })
  assert.ok(fs.existsSync(protectedJob.file))
})

test('partially failed cleanup remains visible and resumes safely after reopening the host', async t => {
  const f = fixture(); const { job, file } = await exported(f)
  const plan = backupControl(f.host, f.db, { action: 'previewRemoval', id: job.id }).removal!
  const original = fs.rmSync
  let calls = 0
  const replacement = t.mock.method(fs, 'rmSync', (...args: Parameters<typeof fs.rmSync>) => {
    if (++calls === 2) throw new Error('模拟磁盘权限错误')
    return original(...args)
  })
  const input = { action: 'removeRecord' as const, id: job.id, deleteFiles: true, digest: plan.digest }
  assert.throws(() => f.request(input), /清理未完成/)
  replacement.mock.restore()
  assert.equal(fs.existsSync(file), false)
  assert.ok(backupControl(f.host, f.db, { action: 'list' }).jobs.some(item => item.id === job.id))
  recoverBackupOperations(f.host, f.db)
  assert.equal(backupControl(f.host, f.db, { action: 'previewRemoval', id: job.id }).removal!.cleanupStarted, true)
  assert.throws(() => f.request({ action: 'removeRecord', id: job.id }), { message: /清理尚未完成/ })
  f.request(input)
  assert.equal(backupControl(f.host, f.db, { action: 'list' }).jobs.length, 0)
})

test('cleanup never follows links out of the managed directory', async () => {
  const f = fixture(); const { job, file } = await exported(f)
  const outside = path.join(f.dir, '原始文件'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
  const link = path.join(f.dir, 'backups/operations', job.id, 'outside-link')
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  const plan = backupControl(f.host, f.db, { action: 'previewRemoval', id: job.id }).removal!
  assert.match(plan.blockedReason!, /链接|越界/)
  assert.throws(() => f.request({ action: 'removeRecord', id: job.id, deleteFiles: true, digest: plan.digest }), /链接|越界/)
  assert.ok(fs.existsSync(file))
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep')
})
