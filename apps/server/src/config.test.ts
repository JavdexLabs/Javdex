import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { hashPassword } from '@http/auth'
import { loadServerConfig, ServerConfigError } from './config'

const previousEnv = { ...process.env }

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-server-config-'))
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

describe('server config', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key]
    }
    Object.assign(process.env, previousEnv)
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('rejects relative data directories and missing web password', async () => {
    const root = tempDir()
    roots.push(root)
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html>')
    const configPath = path.join(root, 'server.json')
    writeJson(configPath, {
      accessHosts: ['127.0.0.1'],
      dataDir: 'data',
      staticRoot: path.join(root),
      web: { username: 'viewer' }
    })
    await assert.rejects(
      loadServerConfig({}, ['node', 'index', '--config', configPath]),
      ServerConfigError
    )
    writeJson(configPath, {
      accessHosts: ['127.0.0.1'],
      dataDir: path.join(root, 'data'),
      staticRoot: path.join(root),
      web: { username: 'viewer' }
    })
    await assert.rejects(
      loadServerConfig({}, ['node', 'index', '--config', configPath]),
      /JAVDEX_WEB_PASSWORD/
    )
  })

  it('hashes an env password and keeps media mounts absolute', async () => {
    const root = tempDir()
    roots.push(root)
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html>')
    const configPath = path.join(root, 'server.json')
    const media = path.join(root, 'media')
    fs.mkdirSync(media)
    writeJson(configPath, {
      accessHosts: ['127.0.0.1'],
      dataDir: path.join(root, 'data'),
      staticRoot: root,
      mediaMounts: { library: media },
      web: { username: 'viewer' }
    })
    const loaded = await loadServerConfig(
      { JAVDEX_WEB_PASSWORD: 'correct horse battery' },
      ['node', 'index', 'start', '--config', configPath]
    )
    assert.equal(loaded.command, 'start')
    assert.match(loaded.config.web.passwordHash, /^[a-f0-9]{32}:[a-f0-9]{128}$/)
    assert.equal(loaded.config.mediaMounts.library, path.resolve(media))
    const known = await hashPassword('correct horse battery')
    assert.equal(known.length, loaded.config.web.passwordHash.length)
  })
})
