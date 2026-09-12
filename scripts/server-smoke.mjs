import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const docker = spawnSync('docker', ['version'], { encoding: 'utf8' })
if (docker.status !== 0) {
  process.stderr.write(
    'server:smoke requires Docker to build the Linux image and run a container with a temporary volume.\n'
  )
  process.stderr.write(docker.stderr || docker.stdout || 'docker is not available\n')
  process.exit(1)
}

const image = 'javdex-server:smoke'
const build = spawnSync('docker', ['build', '-t', image, '.'], { cwd: root, stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status ?? 1)

const volume = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-server-volume-'))
const media = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-server-media-'))
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-server-config-'))
fs.writeFileSync(path.join(media, 'clip.mp4'), Buffer.from('0123456789abcdef'))
fs.writeFileSync(
  path.join(configDir, 'server.json'),
  `${JSON.stringify(
    {
      listenHost: '0.0.0.0',
      port: 8096,
      accessHosts: ['127.0.0.1'],
      dataDir: '/data',
      imagesDir: '/data/media_assets',
      staticRoot: '/app/web',
      mediaMounts: { library: '/media' },
      web: { username: 'viewer' }
    },
    null,
    2
  )}\n`
)

spawnSync('docker', ['rm', '-f', 'javdex-server-smoke'], { stdio: 'ignore' })
const run = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '-d',
    '--name',
    'javdex-server-smoke',
    '-p',
    '8096:8096',
    '-v',
    `${volume}:/data`,
    '-v',
    `${media}:/media`,
    '-v',
    `${configDir}:/config:ro`,
    '-e',
    'JAVDEX_WEB_PASSWORD=correct horse battery',
    image,
    'start',
    '--config',
    '/config/server.json'
  ],
  { encoding: 'utf8' }
)
if (run.status !== 0) {
  process.stderr.write(run.stderr)
  process.exit(run.status ?? 1)
}

const base = 'http://127.0.0.1:8096'
try {
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
  assert.ok(live?.ok, 'container /live did not become ready')
  assert.deepEqual(await live.json(), { status: 'live' })
  assert.equal((await fetch(`${base}/ready`)).status, 200)

  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: {
      Origin: base,
      'Content-Type': 'application/json',
      'X-Javdex-Client': 'web'
    },
    body: JSON.stringify({ username: 'viewer', password: 'correct horse battery', remember: true })
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
  assert.equal((await fetch(`${base}/api/collections`, { headers: { Cookie: cookie } })).status, 503)

  const bind = spawnSync(
    'docker',
    ['exec', 'javdex-server-smoke', 'node', 'index.js', 'bind', '--config', '/config/server.json'],
    { encoding: 'utf8' }
  )
  assert.equal(bind.status, 0, bind.stderr + bind.stdout)
  assert.equal((await fetch(`${base}/api/collections`, { headers: { Cookie: cookie } })).status, 200)

  spawnSync('docker', ['restart', 'javdex-server-smoke'], { stdio: 'inherit' })
  live = null
  for (let i = 0; i < 40; i += 1) {
    try {
      live = await fetch(`${base}/live`)
      if (live.ok) break
    } catch {
      live = null
    }
    await delay(250)
  }
  assert.ok(live?.ok, 'container did not come back after restart')
  assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).status, 200)
  assert.ok(fs.existsSync(path.join(volume, 'library.db')))
  console.log('PASS: Docker image, volume SQLite, bind gate, session restart')
} finally {
  spawnSync('docker', ['rm', '-f', 'javdex-server-smoke'], { stdio: 'ignore' })
  fs.rmSync(volume, { recursive: true, force: true })
  fs.rmSync(media, { recursive: true, force: true })
  fs.rmSync(configDir, { recursive: true, force: true })
}
