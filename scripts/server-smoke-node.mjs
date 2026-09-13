import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashPassword } from '../packages/http/src/auth.ts'
import { closeDatabase, initDatabaseAtPath } from '../packages/library/src/db/database.ts'
import { insertTestVideoWithFile } from '../packages/library/src/db/testVideoFixtures.ts'
import { resolveMediaLibraryRootIdentity } from '../packages/library/src/mediaLibraryRootPath.ts'
import { configureLibraryHost, resetLibraryHostForTests } from '../packages/library/src/runtime/host.ts'
import { digestToken, generateSecret } from '../packages/library/src/catalog/catalogSecrets.ts'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
assert.equal(path.basename(process.execPath), 'node')
assert.equal(process.versions.electron, undefined)

const outDir = path.join(root, 'out', 'server')
if (!fs.existsSync(path.join(outDir, 'index.js'))) {
  console.error('server:smoke:node requires npm run server:build')
  process.exit(1)
}

const install = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-server-prod-'))
const appDir = path.join(install, 'app')
const dataDir = path.join(install, 'data')
const mediaDir = path.join(install, 'media')
const movie = path.join(mediaDir, 'clip.mp4')
fs.cpSync(outDir, appDir, { recursive: true })
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(mediaDir, { recursive: true })
fs.writeFileSync(movie, Buffer.from('0123456789abcdef'))

const npmInstall = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
  cwd: appDir,
  encoding: 'utf8'
})
if (npmInstall.status !== 0) {
  process.stderr.write(npmInstall.stdout)
  process.stderr.write(npmInstall.stderr)
  process.exit(npmInstall.status ?? 1)
}

const modules = fs.readdirSync(path.join(appDir, 'node_modules'))
for (const forbidden of ['electron', 'playwright', 'playwright-core', '@earendil-works']) {
  assert.equal(modules.includes(forbidden), false, `production install contains ${forbidden}`)
}

const password = 'correct horse battery'
const passwordHash = await hashPassword(password)
const configPath = path.join(install, 'server.json')
fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      listenHost: '127.0.0.1',
      port: 0,
      accessHosts: ['127.0.0.1'],
      dataDir,
      imagesDir: path.join(dataDir, 'media_assets'),
      staticRoot: path.join(appDir, 'web'),
      mediaMounts: { library: mediaDir },
      web: { username: 'viewer', passwordHash }
    },
    null,
    2
  )
)

function startServer() {
  const child = spawn(process.execPath, [path.join(appDir, 'index.js'), 'start', '--config', configPath], {
    cwd: appDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    output += chunk.toString()
  })
  return {
    child,
    output: () => output,
    waitForPort: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 20_000)
        const check = () => {
          const match = /listening on 127\.0\.0\.1:(\d+)/.exec(output)
          if (match) {
            clearTimeout(timer)
            resolve(Number(match[1]))
          }
        }
        child.stdout.on('data', check)
        child.stderr.on('data', check)
        check()
      }),
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', (code) => resolve(code ?? 1))
        child.kill('SIGTERM')
      })
  }
}

try {
  const first = startServer()
  const port = await first.waitForPort()
  const base = `http://127.0.0.1:${port}`
  assert.deepEqual(await (await fetch(`${base}/live`)).json(), { status: 'live' })
  assert.equal((await fetch(`${base}/ready`)).status, 200)

  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: {
      Origin: base,
      'Content-Type': 'application/json',
      'X-Javdex-Client': 'web'
    },
    body: JSON.stringify({ username: 'viewer', password, remember: true })
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
  assert.equal((await fetch(`${base}/api/collections`, { headers: { Cookie: cookie } })).status, 503)

  const handshake = await fetch(`${base}/manage/v1/handshake.get`, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: {} })
  })
  assert.equal(handshake.status, 200)
  const hello = await handshake.json()
  assert.equal(hello.ready, 'notBound')
  assert.equal(typeof hello.identity.serverId, 'string')
  assert.equal(hello.capabilities.encryptedAssets, false)

  const bind = spawnSync(process.execPath, [path.join(appDir, 'index.js'), 'bind', '--config', configPath], {
    cwd: appDir,
    encoding: 'utf8'
  })
  assert.equal(bind.status, 0, bind.stderr + bind.stdout)
  const issued = JSON.parse(bind.stdout)
  assert.equal(issued.kind, 'initialBind')
  assert.equal(typeof issued.oneTimeToken, 'string')
  const appVersion = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version
  const secret = generateSecret()
  const claim = await fetch(`${base}/manage/v1/writer.claim`, {
    method: 'POST',
    headers: {
      Origin: base,
      'Content-Type': 'application/json',
      'X-Javdex-App-Version': appVersion
    },
    body: JSON.stringify({
      serverId: hello.identity.serverId,
      catalogId: hello.identity.catalogId,
      input: {
        kind: 'initialBind',
        oneTimeToken: issued.oneTimeToken,
        candidate: { claimId: randomUUID(), secretDigest: digestToken(secret) }
      }
    })
  })
  const claimBody = await claim.text()
  assert.equal(claim.status, 200, claimBody)
  const claimed = JSON.parse(claimBody)
  assert.equal(claimed.bound, true)
  assert.equal(typeof claimed.writerEpoch, 'number')
  assert.ok(claimed.writerEpoch > 0)

  const cookieManage = await fetch(`${base}/manage/v1/writer.status`, {
    method: 'POST',
    headers: {
      Origin: base,
      'Content-Type': 'application/json',
      Cookie: cookie,
      'X-Javdex-App-Version': appVersion
    },
    body: JSON.stringify({
      serverId: hello.identity.serverId,
      catalogId: hello.identity.catalogId,
      input: {}
    })
  })
  assert.equal(cookieManage.status, 401)

  const collections = await fetch(`${base}/api/collections`, { headers: { Cookie: cookie } })
  assert.equal(collections.status, 200)

  assert.equal(await first.stop(), 0)

  configureLibraryHost({
    userDataPath: () => dataDir,
    assets: { assetEncryption: () => false, mediaAssetsPath: () => path.join(dataDir, 'media_assets') }
  })
  const db = initDatabaseAtPath(path.join(dataDir, 'library.db'))
  db.prepare("INSERT INTO actresses (main_name) VALUES ('Smoke')").run()
  const identity = resolveMediaLibraryRootIdentity(mediaDir)
  const timestamp = new Date().toISOString()
  const rootRow = db
    .prepare(
      `INSERT INTO media_library_roots (
         library_id, path, normalized_path, real_path, normalized_real_path,
         device_id, inode, position, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)`
    )
    .run(
      1,
      identity.path,
      identity.normalizedPath,
      identity.realPath,
      identity.normalizedRealPath,
      identity.deviceId,
      identity.inode,
      timestamp,
      timestamp
    )
  const inserted = insertTestVideoWithFile(db, {
    code: 'SMOKE-001',
    filePath: movie,
    libraryId: 1,
    rootId: Number(rootRow.lastInsertRowid)
  })
  closeDatabase()
  resetLibraryHostForTests()

  const second = startServer()
  const port2 = await second.waitForPort()
  const base2 = `http://127.0.0.1:${port2}`
  assert.equal((await fetch(`${base2}/api/session`, { headers: { Cookie: cookie } })).status, 200)
  const ranged = await fetch(`${base2}/api/videos/${inserted.videoId}/media/${inserted.fileId}`, {
    headers: { Cookie: cookie, Range: 'bytes=0-3' }
  })
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers.get('content-range'), 'bytes 0-3/16')
  const reader = (await import('better-sqlite3')).default
  const verify = new reader(path.join(dataDir, 'library.db'), { readonly: true, fileMustExist: true })
  assert.equal(verify.pragma('journal_mode', { simple: true }), 'wal')
  assert.equal((verify.prepare('SELECT main_name FROM actresses').get()).main_name, 'Smoke')
  const version = verify
    .prepare('SELECT generation, revision FROM videos WHERE id = ?')
    .get(inserted.videoId)
  verify.close()

  async function postManage(base, operation, body, bearer) {
    const headers = {
      Origin: base,
      'Content-Type': 'application/json',
      'X-Javdex-App-Version': appVersion
    }
    if (bearer) headers.Authorization = `Bearer ${bearer}`
    const response = await fetch(`${base}/manage/v1/${operation}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
    return { status: response.status, json: await response.json() }
  }

  const created = await postManage(
    base2,
    'uploads.create',
    {
      operationId: randomUUID(),
      serverId: hello.identity.serverId,
      catalogId: hello.identity.catalogId,
      writerEpoch: claimed.writerEpoch,
      expectedVersions: {},
      input: { purpose: 'videoCover', contentType: 'image/png' }
    },
    secret
  )
  assert.equal(created.status, 200, JSON.stringify(created.json))
  const uploadId = created.json.uploadId
  const png = await sharp({
    create: { width: 16, height: 10, channels: 3, background: { r: 20, g: 40, b: 80 } }
  })
    .png()
    .toBuffer()
  const put = await fetch(`${base2}/manage/v1/uploads/${uploadId}`, {
    method: 'PUT',
    headers: {
      Origin: base2,
      'Content-Type': 'image/png',
      'X-Javdex-App-Version': appVersion,
      Authorization: `Bearer ${secret}`
    },
    body: png
  })
  const putBody = await put.json()
  assert.equal(put.status, 200, JSON.stringify(putBody))
  assert.equal(putBody.consumed, false)
  const cookiePut = await fetch(`${base2}/manage/v1/uploads/${uploadId}`, {
    method: 'PUT',
    headers: {
      Origin: base2,
      'Content-Type': 'image/png',
      'X-Javdex-App-Version': appVersion,
      Cookie: cookie
    },
    body: png
  })
  assert.equal(cookiePut.status, 401)
  const applied = await postManage(
    base2,
    'videos.setPoster',
    {
      operationId: randomUUID(),
      serverId: hello.identity.serverId,
      catalogId: hello.identity.catalogId,
      writerEpoch: claimed.writerEpoch,
      expectedVersions: { V: version },
      input: { videoId: inserted.videoId, image: { kind: 'upload', uploadId } }
    },
    secret
  )
  assert.equal(applied.status, 200, JSON.stringify(applied.json))
  const afterApply = new reader(path.join(dataDir, 'library.db'), { readonly: true, fileMustExist: true })
  const coverRel = afterApply.prepare('SELECT cover_path FROM videos WHERE id = ?').get(inserted.videoId)
    .cover_path
  afterApply.close()
  assert.match(coverRel, /^covers\//)
  const coverAbs = path.join(dataDir, 'media_assets', coverRel)
  assert.equal(fs.existsSync(coverAbs), true)
  assert.equal(await second.stop(), 0)

  const third = startServer()
  const port3 = await third.waitForPort()
  const base3 = `http://127.0.0.1:${port3}`
  assert.equal(fs.existsSync(coverAbs), true)
  const cover = await fetch(`${base3}/api/videos/${inserted.videoId}/images/cover`, {
    headers: { Cookie: cookie }
  })
  assert.equal(cover.status, 200)
  assert.equal(await third.stop(), 0)
  console.log(
    'PASS: isolated Node production install, SQLite/WAL, HTTP, Range, session, writer claim gate, image upload/apply/restart, SIGTERM'
  )
} finally {
  resetLibraryHostForTests()
  closeDatabase()
  fs.rmSync(install, { recursive: true, force: true })
}
