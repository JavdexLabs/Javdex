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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_NAME = 'javdex-server-migration-source'
const TARGET_NAME = 'javdex-server-migration-target'
const RACE_NAME = 'javdex-server-migration-race-target'
const SOURCE_PORT = 18096
const TARGET_PORT = 18097
const RACE_PORT = 18098
const COVER_REL = 'covers/s13-docker.png'
const VIDEO_CODE = 'S13-DOCKER'
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

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
  fs.writeFileSync(path.join(sourceImages, COVER_REL), PNG_1X1)
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
      '--rm',
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

writeServerConfig(sourceConfig, SOURCE_PORT)
writeServerConfig(targetConfig, TARGET_PORT)
writeServerConfig(raceConfig, RACE_PORT)
const rootId = seedSourceCatalog(sourceData, sourceImages, sourceMedia)
assert.ok(rootId > 0)
assert.equal(fs.existsSync(path.join(sourceImages, COVER_REL)), true)
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

  runContainer({
    name: RACE_NAME,
    port: RACE_PORT,
    dataDir: raceData,
    imagesDir: raceImages,
    mediaDir: raceMedia,
    configDir: raceConfig,
    image
  })
  const raceBase = `http://127.0.0.1:${RACE_PORT}`
  await waitLive(raceBase, 'race-target')
  const raceToken = issueMigrateAuth(RACE_NAME)
  assert.equal(await putPackage(raceBase, mapped.migrationId, fs.readFileSync(pkg), raceToken), 200)
  const raceImported = await postManage(
    raceBase,
    'migration.start',
    { input: { migrationId: mapped.migrationId, digest: mapped.digest } },
    raceToken
  )
  assert.equal(raceImported.status, 200, JSON.stringify(raceImported.json))
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

  console.log(
    'PASS: Docker dual-host migrate-auth, package, start/enable, status phases, official images, source frozen backup, enable/abandon race'
  )
} catch (error) {
  process.stderr.write(docker(['logs', '--tail', '80', SOURCE_NAME]).stdout || '')
  process.stderr.write(docker(['logs', '--tail', '80', TARGET_NAME]).stdout || '')
  process.stderr.write(docker(['logs', '--tail', '80', RACE_NAME]).stdout || '')
  throw error
} finally {
  docker(['rm', '-f', SOURCE_NAME], { stdio: 'ignore' })
  docker(['rm', '-f', TARGET_NAME], { stdio: 'ignore' })
  docker(['rm', '-f', RACE_NAME], { stdio: 'ignore' })
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
    raceConfig
  ]) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
