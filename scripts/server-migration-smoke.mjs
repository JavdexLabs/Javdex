import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { isStructuredError } from '@shared/protocol/errors'
import Database from 'better-sqlite3'
import { insertTestVideoWithFile } from '@library/db/testVideoFixtures'
import { resolveMediaLibraryRootIdentity } from '@library/mediaLibraryRootPath'
import { ensureCatalogIdentity, readCatalogIdentity } from '@library/catalog/catalogIdentity'
import { openIsolatedCatalog } from '@library/catalog/catalogMigration'
import { catalogLooksEmpty } from '@library/catalog/catalogMigrationState'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_NAME = 'javdex-server-migration-source'
const TARGET_NAME = 'javdex-server-migration-target'
const RACE_NAME = 'javdex-server-migration-race-target'
const EACCES_NAME = 'javdex-server-migration-eacces-target'
const ENOSPC_NAME = 'javdex-server-migration-enospc-target'
const SOURCE_PORT = 18096
const TARGET_PORT = 18097
const RACE_PORT = 18098
const EACCES_PORT = 18099
const ENOSPC_PORT = 18100
const COVER_REL = 'covers/s13-docker.png'
const VIDEO_CODE = 'S13-DOCKER'
const COVER_BYTES = Buffer.alloc(400 * 1024, 0x7f)
const CONTAINER_NAMES = [SOURCE_NAME, TARGET_NAME, RACE_NAME, EACCES_NAME, ENOSPC_NAME]

function docker(args, options = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...options })
}

function requireDocker() {
  const version = docker(['version'])
  if (version.status !== 0) {
    process.stderr.write(
      'server:smoke:migration requires a real Docker daemon to run two containers with separate volumes.\n'
    )
    process.stderr.write(version.stderr || version.stdout || 'docker is not available\n')
    process.exit(1)
  }
}

function writeServerConfig(configDir, port) {
  fs.writeFileSync(
    path.join(configDir, 'server.json'),
    `${JSON.stringify(
      {
        listenHost: '0.0.0.0',
        port,
        accessHosts: ['127.0.0.1'],
        dataDir: '/data',
        imagesDir: '/images',
        staticRoot: '/app/web',
        mediaMounts: { library: '/media' },
        web: { username: 'viewer' }
      },
      null,
      2
    )}\n`
  )
}

function insertRoot(db, dir, containerPath) {
  const hostIdentity = resolveMediaLibraryRootIdentity(dir)
  const timestamp = new Date().toISOString()
  const row = db
    .prepare(
      `INSERT INTO media_library_roots (
         library_id, path, normalized_path, real_path, normalized_real_path,
         device_id, inode, position, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)`
    )
    .run(
      1,
      containerPath,
      containerPath,
      containerPath,
      containerPath,
      hostIdentity.deviceId,
      hostIdentity.inode,
      timestamp,
      timestamp
    )
  return Number(row.lastInsertRowid)
}

function seedSourceCatalog(sourceData, sourceImages, sourceMedia) {
  fs.mkdirSync(path.join(sourceImages, 'covers'), { recursive: true })
  fs.writeFileSync(path.join(sourceImages, COVER_REL), COVER_BYTES)
  const clip = path.join(sourceMedia, `${VIDEO_CODE}.mp4`)
  fs.writeFileSync(clip, Buffer.from('0123456789abcdef'))
  const sourceDb = openIsolatedCatalog(path.join(sourceData, 'library.db'))
  let rootId = 0
  try {
    ensureCatalogIdentity({ serverId: randomUUID() }, sourceDb)
    rootId = insertRoot(sourceDb, sourceMedia, '/media')
    insertTestVideoWithFile(sourceDb, {
      code: VIDEO_CODE,
      title: 'Docker dual-host clip',
      filePath: `/media/${VIDEO_CODE}.mp4`,
      libraryId: 1,
      rootId
    })
    sourceDb.prepare('UPDATE videos SET cover_path = ? WHERE code = ?').run(COVER_REL, VIDEO_CODE)
  } finally {
    sourceDb.close()
  }
  return rootId
}

function runContainer({ name, port, dataDir, imagesDir, mediaDir, configDir, image }) {
  docker(['rm', '-f', name], { stdio: 'ignore' })
  const run = docker(
    [
      'run',
      '-d',
      '--name',
      name,
      '-p',
      `${port}:${port}`,
      '-v',
      `${dataDir}:/data`,
      '-v',
      `${imagesDir}:/images`,
      '-v',
      `${mediaDir}:/media`,
      '-v',
      `${configDir}:/config:ro`,
      '-e',
      'JAVDEX_WEB_PASSWORD=correct horse battery',
      image,
      'start',
      '--config',
      '/config/server.json'
    ],
    { stdio: 'pipe' }
  )
  if (run.status !== 0) {
    process.stderr.write(run.stderr || run.stdout || `failed to start ${name}\n`)
    process.exit(run.status ?? 1)
  }
}

async function waitLive(base, label) {
  let live = null
  for (let i = 0; i < 40; i += 1) {
    try {
      live = await fetch(`${base}/live`)
      if (live.ok) break
    } catch {
      live = null
    }
    await delay(250)
  }
  assert.ok(live?.ok, `${label} /live did not become ready`)
  assert.deepEqual(await live.json(), { status: 'live' })
  assert.equal((await fetch(`${base}/ready`)).status, 200)
}

function issueMigrateAuth(name) {
  const issued = docker(
    ['exec', name, 'node', 'index.js', 'migrate-auth', '--config', '/config/server.json'],
    { stdio: 'pipe' }
  )
  assert.equal(issued.status, 0, `${name} migrate-auth failed\n${issued.stderr}${issued.stdout}`)
  const parsed = JSON.parse(issued.stdout)
  assert.equal(typeof parsed.oneTimeToken, 'string')
  return parsed.oneTimeToken
}

async function postManage(base, operation, body, bearer) {
  const appVersion = JSON.parse(fs.readFileSync(path.join(root, 'out', 'server', 'package.json'), 'utf8'))
    .version
  const response = await fetch(`${base}/manage/v1/${operation}`, {
    method: 'POST',
    headers: {
      Origin: base,
      'Content-Type': 'application/json',
      'X-Javdex-App-Version': appVersion,
      Authorization: `Bearer ${bearer}`
    },
    body: JSON.stringify(body)
  })
  return { status: response.status, json: await response.json() }
}

async function putPackage(base, migrationId, body, bearer) {
  const appVersion = JSON.parse(fs.readFileSync(path.join(root, 'out', 'server', 'package.json'), 'utf8'))
    .version
  const response = await fetch(`${base}/manage/v1/migration/packages/${migrationId}`, {
    method: 'PUT',
    headers: {
      Origin: base,
      'Content-Type': 'application/octet-stream',
      'X-Javdex-App-Version': appVersion,
      Authorization: `Bearer ${bearer}`
    },
    body: new Uint8Array(body)
  })
  return response.status
}

function readFrozenAndCodes(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    return {
      identity: readCatalogIdentity(db),
      codes: db.prepare('SELECT code FROM videos ORDER BY code').all().map((row) => row.code),
      coverPath: db.prepare('SELECT cover_path FROM videos WHERE code = ?').get(VIDEO_CODE)?.cover_path
    }
  } finally {
    db.close()
  }
}

function assertCatalogRolledBack(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    assert.equal(catalogLooksEmpty(db), true, 'target catalog must stay empty after copy failure')
    const identity = readCatalogIdentity(db)
    assert.ok(identity, 'rolled-back target still has catalog identity')
  } finally {
    db.close()
  }
}

function mountTmpfs(dir, sizeSpec) {
  const result = spawnSync(
    'sudo',
    ['-n', 'mount', '-t', 'tmpfs', '-o', `${sizeSpec},mode=1777`, 'tmpfs', dir],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) {
    throw new Error(`mount tmpfs ${dir} failed\n${result.stderr || ''}${result.stdout || ''}`)
  }
}

function unmountTmpfs(dir) {
  for (let i = 0; i < 20; i += 1) {
    const mounted = spawnSync('findmnt', ['-n', '--mountpoint', dir], { encoding: 'utf8' })
    if (mounted.status !== 0) return
    spawnSync('sudo', ['-n', 'umount', dir], { encoding: 'utf8', stdio: 'ignore' })
    spawnSync('sleep', ['0.25'])
  }
  const still = spawnSync('findmnt', ['-n', '--mountpoint', dir], { encoding: 'utf8' })
  if (still.status === 0) {
    throw new Error(`tmpfs still mounted on ${dir}\n${still.stdout}`)
  }
}

function dumpContainer(name) {
  process.stderr.write(docker(['ps', '-a', '--filter', `name=${name}`]).stdout || '')
  process.stderr.write(docker(['logs', '--tail', '120', name]).stdout || '')
  process.stderr.write(docker(['logs', '--tail', '120', name]).stderr || '')
}

async function importPackageToReady({
  name,
  port,
  dataDir,
  imagesDir,
  mediaDir,
  configDir,
  image,
  pkg,
  migrationId,
  digest
}) {
  runContainer({ name, port, dataDir, imagesDir, mediaDir, configDir, image })
  const base = `http://127.0.0.1:${port}`
  await waitLive(base, name)
  const token = issueMigrateAuth(name)
  assert.equal(await putPackage(base, migrationId, fs.readFileSync(pkg), token), 200)
  const imported = await postManage(
    base,
    'migration.start',
    { input: { migrationId, digest } },
    token
  )
  assert.equal(imported.status, 200, JSON.stringify(imported.json))
  return { base, token }
}

async function enableMigration(base, migrationId, digest, token) {
  return postManage(base, 'migration.enable', { input: { migrationId, digest } }, token)
}

async function assertTargetReady(base, migrationId, token, label) {
  const status = await postManage(base, 'migration.status', { input: { migrationId } }, token)
  assert.equal(status.status, 200, `${label} ${JSON.stringify(status.json)}`)
  assert.equal(status.json.targetPhase, 'ready', `${label} phase=${status.json.targetPhase}`)
}

requireDocker()

if (!fs.existsSync(path.join(root, 'out', 'server', 'index.js'))) {
  process.stderr.write('server:smoke:migration requires npm run server:build\n')
  process.exit(1)
}

const image = 'javdex-server:smoke'
const build = spawnSync('docker', ['build', '-t', image, '.'], { cwd: root, stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status ?? 1)

const sourceData = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-source-data-'))
const sourceImages = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-source-images-'))
const sourceMedia = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-source-media-'))
const sourceConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-source-config-'))
const targetData = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-target-data-'))
const targetImages = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-target-images-'))
const targetMedia = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-target-media-'))
const targetConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-target-config-'))
const raceData = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-race-data-'))
const raceImages = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-race-images-'))
const raceMedia = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-race-media-'))
const raceConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-race-config-'))
const eaccesData = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-eacces-data-'))
const eaccesImages = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-eacces-images-'))
const eaccesMedia = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-eacces-media-'))
const eaccesConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-eacces-config-'))
const enospcData = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-enospc-data-'))
const enospcImages = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-enospc-images-'))
const enospcMedia = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-enospc-media-'))
const enospcConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-mig-enospc-config-'))

writeServerConfig(sourceConfig, SOURCE_PORT)
writeServerConfig(targetConfig, TARGET_PORT)
writeServerConfig(raceConfig, RACE_PORT)
writeServerConfig(eaccesConfig, EACCES_PORT)
writeServerConfig(enospcConfig, ENOSPC_PORT)
const rootId = seedSourceCatalog(sourceData, sourceImages, sourceMedia)
assert.ok(rootId > 0)
assert.equal(fs.existsSync(path.join(sourceImages, COVER_REL)), true)
assert.equal(fs.statSync(path.join(sourceImages, COVER_REL)).size, COVER_BYTES.length)
assert.equal(fs.existsSync(path.join(targetData, 'library.db')), false)
assert.equal(fs.readdirSync(targetImages).length, 0)

const sourceBase = `http://127.0.0.1:${SOURCE_PORT}`
const targetBase = `http://127.0.0.1:${TARGET_PORT}`

try {
  runContainer({
    name: SOURCE_NAME,
    port: SOURCE_PORT,
    dataDir: sourceData,
    imagesDir: sourceImages,
    mediaDir: sourceMedia,
    configDir: sourceConfig,
    image
  })
  runContainer({
    name: TARGET_NAME,
    port: TARGET_PORT,
    dataDir: targetData,
    imagesDir: targetImages,
    mediaDir: targetMedia,
    configDir: targetConfig,
    image
  })

  await waitLive(sourceBase, 'source')
  await waitLive(targetBase, 'target')

  const sourceToken = issueMigrateAuth(SOURCE_NAME)
  const targetToken = issueMigrateAuth(TARGET_NAME)

  const preview = await postManage(
    sourceBase,
    'migration.preview',
    { input: { mappings: [{ sourceRootId: rootId, targetMountSelectionId: 'library' }] } },
    sourceToken
  )
  assert.equal(preview.status, 200, JSON.stringify(preview.json))
  const mapped = preview.json
  assert.equal(typeof mapped.migrationId, 'string')
  assert.equal(typeof mapped.digest, 'string')

  const started = await postManage(
    sourceBase,
    'migration.start',
    { input: { migrationId: mapped.migrationId, digest: mapped.digest } },
    sourceToken
  )
  assert.equal(started.status, 200, JSON.stringify(started.json))

  const pkg = path.join(sourceData, 'migration-packages', `${mapped.migrationId}.tar.gz`)
  assert.equal(fs.existsSync(pkg), true, 'source did not write migration package')

  assert.equal(await putPackage(targetBase, mapped.migrationId, fs.readFileSync(pkg), targetToken), 200)

  const imported = await postManage(
    targetBase,
    'migration.start',
    { input: { migrationId: mapped.migrationId, digest: mapped.digest } },
    targetToken
  )
  assert.equal(imported.status, 200, JSON.stringify(imported.json))

  const enabled = await postManage(
    targetBase,
    'migration.enable',
    { input: { migrationId: mapped.migrationId, digest: mapped.digest } },
    targetToken
  )
  assert.equal(enabled.status, 200, JSON.stringify(enabled.json))
  assert.equal(enabled.json.targetPhase, 'enabled')

  const sourceStatus = await postManage(
    sourceBase,
    'migration.status',
    { input: { migrationId: mapped.migrationId } },
    sourceToken
  )
  const targetStatus = await postManage(
    targetBase,
    'migration.status',
    { input: { migrationId: mapped.migrationId } },
    targetToken
  )
  assert.equal(sourceStatus.status, 200, JSON.stringify(sourceStatus.json))
  assert.equal(targetStatus.status, 200, JSON.stringify(targetStatus.json))
  assert.equal(sourceStatus.json.sourcePhase, 'frozen')
  assert.equal(targetStatus.json.targetPhase, 'enabled')

  const sourceAfter = readFrozenAndCodes(path.join(sourceData, 'library.db'))
  const targetAfter = readFrozenAndCodes(path.join(targetData, 'library.db'))
  assert.equal(sourceAfter.identity?.frozen, true, 'source must remain a frozen backup')
  assert.equal(targetAfter.identity?.frozen, false)
  assert.deepEqual(sourceAfter.codes, [VIDEO_CODE])
  assert.deepEqual(targetAfter.codes, [VIDEO_CODE])
  assert.equal(sourceAfter.coverPath, COVER_REL)
  assert.equal(targetAfter.coverPath, COVER_REL)
  assert.equal(fs.existsSync(path.join(sourceImages, COVER_REL)), true, 'source official image must stay')
  assert.equal(fs.existsSync(path.join(targetImages, COVER_REL)), true, 'target official image missing after enable')
  assert.ok(targetAfter.identity?.catalogId)
  assert.notEqual(targetAfter.identity.catalogId, sourceAfter.identity.catalogId)
  assert.equal(fs.existsSync(path.join(targetData, 'library.db')), true)

  const { base: raceBase, token: raceToken } = await importPackageToReady({
    name: RACE_NAME,
    port: RACE_PORT,
    dataDir: raceData,
    imagesDir: raceImages,
    mediaDir: raceMedia,
    configDir: raceConfig,
    image,
    pkg,
    migrationId: mapped.migrationId,
    digest: mapped.digest
  })
  const [raceEnabled, raceAbandoned] = await Promise.all([
    postManage(
      raceBase,
      'migration.enable',
      { input: { migrationId: mapped.migrationId, digest: mapped.digest } },
      raceToken
    ),
    postManage(
      raceBase,
      'migration.abandon',
      { input: { migrationId: mapped.migrationId, digest: mapped.digest } },
      raceToken
    )
  ])
  const raceStatus = await postManage(
    raceBase,
    'migration.status',
    { input: { migrationId: mapped.migrationId } },
    raceToken
  )
  assert.equal(
    raceStatus.status,
    200,
    JSON.stringify({ raceStatus: raceStatus.json, raceEnabled, raceAbandoned })
  )
  const racePhase = raceStatus.json.targetPhase
  assert.ok(racePhase === 'enabled' || racePhase === 'abandoned', racePhase)
  if (racePhase === 'enabled') {
    const raceAfter = readFrozenAndCodes(path.join(raceData, 'library.db'))
    assert.equal(raceAfter.identity?.frozen, false)
    assert.deepEqual(raceAfter.codes, [VIDEO_CODE])
    assert.equal(fs.existsSync(path.join(raceImages, COVER_REL)), true)
    const lateAbandon = await postManage(
      raceBase,
      'migration.abandon',
      { input: { migrationId: mapped.migrationId, digest: mapped.digest } },
      raceToken
    )
    assert.equal(lateAbandon.status, 200, JSON.stringify(lateAbandon.json))
    assert.equal(lateAbandon.json.targetPhase, 'enabled')
  } else {
    const lateEnable = await postManage(
      raceBase,
      'migration.enable',
      { input: { migrationId: mapped.migrationId, digest: mapped.digest } },
      raceToken
    )
    assert.equal(lateEnable.status, 401, JSON.stringify(lateEnable.json))
    assert.equal(isStructuredError(lateEnable.json) && lateEnable.json.code === 'AUTH_REQUIRED', true)
  }

  const { base: eaccesBase, token: eaccesToken } = await importPackageToReady({
    name: EACCES_NAME,
    port: EACCES_PORT,
    dataDir: eaccesData,
    imagesDir: eaccesImages,
    mediaDir: eaccesMedia,
    configDir: eaccesConfig,
    image,
    pkg,
    migrationId: mapped.migrationId,
    digest: mapped.digest
  })
  fs.chmodSync(eaccesImages, 0)
  let eaccesFailed
  try {
    eaccesFailed = await enableMigration(eaccesBase, mapped.migrationId, mapped.digest, eaccesToken)
  } finally {
    fs.chmodSync(eaccesImages, 0o755)
  }
  assert.equal(eaccesFailed.status, 400, JSON.stringify(eaccesFailed.json))
  assert.equal(isStructuredError(eaccesFailed.json), true)
  assert.match(String(eaccesFailed.json.message), /EACCES/)
  await assertTargetReady(eaccesBase, mapped.migrationId, eaccesToken, 'eacces')
  assertCatalogRolledBack(path.join(eaccesData, 'library.db'))
  assert.equal(fs.existsSync(path.join(eaccesImages, COVER_REL)), false)
  const eaccesRetried = await enableMigration(
    eaccesBase,
    mapped.migrationId,
    mapped.digest,
    eaccesToken
  )
  assert.equal(eaccesRetried.status, 200, JSON.stringify(eaccesRetried.json))
  assert.equal(eaccesRetried.json.targetPhase, 'enabled')
  assert.equal(fs.existsSync(path.join(eaccesImages, COVER_REL)), true)

  mountTmpfs(enospcImages, 'size=256k')
  let enospcBase
  let enospcToken
  try {
    const imported = await importPackageToReady({
      name: ENOSPC_NAME,
      port: ENOSPC_PORT,
      dataDir: enospcData,
      imagesDir: enospcImages,
      mediaDir: enospcMedia,
      configDir: enospcConfig,
      image,
      pkg,
      migrationId: mapped.migrationId,
      digest: mapped.digest
    })
    enospcBase = imported.base
    enospcToken = imported.token
    const enospcFailed = await enableMigration(
      enospcBase,
      mapped.migrationId,
      mapped.digest,
      enospcToken
    )
    assert.equal(enospcFailed.status, 400, JSON.stringify(enospcFailed.json))
    assert.equal(isStructuredError(enospcFailed.json), true)
    assert.match(String(enospcFailed.json.message), /ENOSPC/)
    await assertTargetReady(enospcBase, mapped.migrationId, enospcToken, 'enospc')
    assertCatalogRolledBack(path.join(enospcData, 'library.db'))
    assert.equal(fs.existsSync(path.join(enospcImages, COVER_REL)), false)
  } finally {
    docker(['stop', '-t', '5', ENOSPC_NAME], { stdio: 'ignore' })
    docker(['rm', '-f', ENOSPC_NAME], { stdio: 'ignore' })
    unmountTmpfs(enospcImages)
  }
  assert.ok(enospcBase && enospcToken, 'ENOSPC import did not finish before retry')
  fs.mkdirSync(enospcImages, { recursive: true })
  fs.chmodSync(enospcImages, 0o755)
  runContainer({
    name: ENOSPC_NAME,
    port: ENOSPC_PORT,
    dataDir: enospcData,
    imagesDir: enospcImages,
    mediaDir: enospcMedia,
    configDir: enospcConfig,
    image
  })
  try {
    await waitLive(enospcBase, 'enospc-retry')
  } catch (error) {
    dumpContainer(ENOSPC_NAME)
    throw error
  }
  const enospcRetried = await enableMigration(
    enospcBase,
    mapped.migrationId,
    mapped.digest,
    enospcToken
  )
  assert.equal(enospcRetried.status, 200, JSON.stringify(enospcRetried.json))
  assert.equal(enospcRetried.json.targetPhase, 'enabled')
  assert.equal(fs.existsSync(path.join(enospcImages, COVER_REL)), true)

  console.log(
    'PASS: Docker dual-host migrate-auth, package, start/enable, status phases, official images, source frozen backup, enable/abandon race, copy EACCES/ENOSPC rollback'
  )
} catch (error) {
  for (const name of CONTAINER_NAMES) {
    process.stderr.write(docker(['logs', '--tail', '80', name]).stdout || '')
  }
  throw error
} finally {
  for (const name of CONTAINER_NAMES) {
    docker(['rm', '-f', name], { stdio: 'ignore' })
  }
  try {
    fs.chmodSync(eaccesImages, 0o755)
  } catch {
    // Directory may already be writable or removed.
  }
  unmountTmpfs(enospcImages)
  for (const dir of [
    sourceData,
    sourceImages,
    sourceMedia,
    sourceConfig,
    targetData,
    targetImages,
    targetMedia,
    targetConfig,
    raceData,
    raceImages,
    raceMedia,
    raceConfig,
    eaccesData,
    eaccesImages,
    eaccesMedia,
    eaccesConfig,
    enospcData,
    enospcImages,
    enospcMedia,
    enospcConfig
  ]) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
