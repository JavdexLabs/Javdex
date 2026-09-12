import assert from 'node:assert/strict'
import { it, mock } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebAccess } from './webAccess'
import { WebSessions } from './auth'

it('keeps the running service on staging failure and restores it after publish failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-save-'))
  const file = path.join(dir, 'config.json')
  const access = new WebAccess()
  const sessions = new WebSessions()
  const remembered = sessions.create(true)
  const original = { enabled: true, port: 8088, username: 'viewer', passwordHash: 'existing' }
  const server = { stop: async () => {}, pairing: { activity: () => [], enabledUntil: 0 } }
  let starts = 0
  Object.assign(access, { config: original, server, sessions,
    file: () => file, store: () => sessions,
    listen: async () => { starts++; Object.assign(access, { server }) }
  })
  fs.writeFileSync(file, JSON.stringify(original))
  try {
    const write = mock.method(fs, 'writeFileSync', () => { throw new Error('disk full') })
    await assert.rejects(access.apply({ enabled: true, port: 8090, username: 'viewer' }), /原配置未更改/)
    write.mock.restore()
    assert.equal(starts, 0)
    assert.equal(access.status().running, true)
    const rename = mock.method(fs, 'renameSync', () => { throw new Error('rename denied') })
    await assert.rejects(access.apply({ enabled: true, port: 8090, username: 'viewer' }), /原配置未更改/)
    rename.mock.restore()
    assert.equal(starts, 1)
    assert.equal(access.status().port, 8088)
    assert.equal(access.status().running, true)
    assert.equal(sessions.check(remembered), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original)
    assert.equal(fs.existsSync(file + '.tmp'), false)
    // A credential change must never restore revoked tokens on rollback.
    const renameAgain = mock.method(fs, 'renameSync', () => { throw new Error('rename denied') })
    await assert.rejects(access.apply({ enabled: true, port: 8088, username: 'new-viewer' }))
    renameAgain.mock.restore()
    assert.equal(access.status().running, true)
    assert.equal(sessions.check(remembered), false)
    await access.stop()
    await access.apply({ enabled: true, port: 8088, username: 'viewer' })
    assert.equal(access.status().running, true)
    const persistent = sessions.create(true, 'remembered')
    await access.apply({ enabled: false, port: 8088, username: 'viewer' })
    assert.equal(sessions.check(persistent), true)
    await access.apply({ enabled: true, port: 8088, username: 'viewer' })
    assert.equal(sessions.check(persistent), true)
    await access.apply({ enabled: true, port: 8088, username: 'viewer', password: 'new-password-123' })
    assert.equal(sessions.check(persistent), false)
  } finally { mock.restoreAll(); fs.rmSync(dir, { recursive: true, force: true }) }
})

it('preserves remembered devices on runtime server errors, including failed state persistence', async () => {
  const { WebServer } = await import('./server')
  const sessions = new WebSessions()
  const token = sessions.create(true, 'TV')
  const errors: string[] = []
  const server = new WebServer({ username: 'viewer', passwordHash: '', staticRoot: '',
    catalog: {} as import('./catalog').WebCatalogReader, sessions, onError: message => errors.push(message) })
  try {
    await server.start(0, '127.0.0.1')
    const socketServer = Reflect.get(server, 'server') as import('node:http').Server
    const closed = new Promise<void>(resolve => socketServer.once('close', resolve))
    assert.doesNotThrow(() => socketServer.emit('error', new Error('network failure')))
    await closed
    assert.equal(sessions.check(token), true)
    assert.equal(errors.length, 1)
    await server.start(0, '127.0.0.1')
    const socketServer2 = Reflect.get(server, 'server') as import('node:http').Server
    const closed2 = new Promise<void>(resolve => socketServer2.once('close', resolve))
    const suspend = mock.method(sessions, 'suspend', () => { throw new Error('disk failure') })
    assert.doesNotThrow(() => socketServer2.emit('error', new Error('network failure')))
    await closed2
    await new Promise(resolve => setImmediate(resolve))
    suspend.mock.restore()
    assert.equal(sessions.check(token), true)
    assert.match(errors.at(-1)!, /保存失败/)
  } finally { mock.restoreAll(); await server.stop() }
})
