import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { loadUpdaterConfig } from './config'

test('image roots cannot contain the data root and cause overlapping restore targets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-updater-roots-'))
  try {
    const file = path.join(root, 'config.json')
    const runtimeDir = path.join(root, 'program')
    fs.writeFileSync(file, JSON.stringify({ dataDir: path.join(root, 'owned', 'data'), imagesDir: path.join(root, 'owned') }))
    assert.throws(() => loadUpdaterConfig(file, { env: { JAVDEX_RUNTIME_DIR: runtimeDir } }), /图片目录不能包含/)
    assert.equal(fs.existsSync(runtimeDir), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('updater initialization cannot take over a nonempty unrelated directory or another deployment journal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-updater-config-'))
  try {
    const state = path.join(root, 'state')
    fs.mkdirSync(state)
    fs.writeFileSync(path.join(state, 'user-file'), 'preserved')
    const file = path.join(root, 'config.json')
    const config = { dataDir: path.join(root, 'data'), port: 8096 }
    fs.writeFileSync(file, JSON.stringify(config))
    assert.throws(() => loadUpdaterConfig(file, { env: { JAVDEX_RUNTIME_DIR: state } }), /专用/)
    assert.equal(fs.readFileSync(path.join(state, 'user-file'), 'utf8'), 'preserved')
    const dedicated = path.join(root, 'dedicated')
    fs.mkdirSync(dedicated)
    fs.chmodSync(dedicated, 0o777)
    if (process.getuid?.() === 0) fs.chownSync(dedicated, 1000, 1000)
    const env = { JAVDEX_RUNTIME_DIR: dedicated, JAVDEX_UPDATE_PUBLIC_URL: 'https://127.0.0.1:8097' }
    loadUpdaterConfig(file, { env })
    assert.equal(fs.statSync(dedicated).mode & 0o777, 0o755)
    assert.equal(fs.statSync(path.join(dedicated, 'state')).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.join(dedicated, 'releases')).mode & 0o777, 0o755)
    if (process.getuid?.() === 0) assert.equal(fs.statSync(dedicated).uid, 0)
    loadUpdaterConfig(file, { env })
    fs.writeFileSync(file, JSON.stringify({ ...config, dataDir: path.join(root, 'another-data') }))
    assert.throws(() => loadUpdaterConfig(file, { env }), /另一份资料库/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('kernel deployment lock rejects a second updater and releases after abrupt process death', { skip: process.platform !== 'linux' || spawnSync('flock', ['--version']).status !== 0 ? 'Requires Linux util-linux flock; this is not container acceptance' : false }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-updater-lock-'))
  const lock = path.join(root, 'deployment.lock')
  const child = spawn('flock', ['--nonblock', '--no-fork', lock, process.execPath, '-e', "console.log('locked');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] })
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()))
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('lock holder failed to start'))) })
    assert.notEqual(spawnSync('flock', ['--nonblock', '--no-fork', lock, process.execPath, '-e', 'process.exit(0)']).status, 0)
    child.kill('SIGKILL')
    await exit
    assert.equal(spawnSync('flock', ['--nonblock', '--no-fork', lock, process.execPath, '-e', 'process.exit(0)']).status, 0)
  } finally { child.kill('SIGKILL'); await exit; fs.rmSync(root, { recursive: true, force: true }) }
})
