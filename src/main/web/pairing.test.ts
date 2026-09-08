import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebPairing, WebSessions } from './auth'

describe('Desktop-approved browser pairing', () => {
  it('requires an open window, a desktop decision and a separate secret, consumes only once', () => {
    const pairing = new WebPairing(() => 1000)
    assert.throws(() => pairing.create(true, 'TV'))
    pairing.open()
    const request = pairing.create(true, 'TV')
    assert.match(request.code, /^\d{6}$/)
    assert.throws(() => pairing.poll(request.code))
    assert.deepEqual(pairing.inspect(request.code), {
      name: 'TV',
      expires: 301000,
      remember: true
    })
    pairing.decide(request.code, true)
    assert.equal(pairing.poll(request.secret)?.name, 'TV')
    assert.throws(() => pairing.poll(request.secret))
  })
  it('expires requests, bounds polling, rejection, restart and approvals', () => {
    let now = 0
    const pairing = new WebPairing(() => now)
    pairing.open()
    const denied = pairing.create(false, 'TV')
    pairing.decide(denied.code, false)
    assert.throws(() => pairing.poll(denied.secret))
    const pending = pairing.create(false, 'phone')
    assert.equal(pairing.poll(pending.secret), null)
    assert.throws(() => pairing.poll(pending.secret))
    now += 5000
    assert.equal(pairing.poll(pending.secret), null)
    pairing.decide(pending.code, true)
    now += 60_000
    assert.throws(() => pairing.poll(pending.secret))
    const stale = pairing.create(false, 'laptop')
    pairing.clear()
    assert.throws(() => pairing.poll(stale.secret))
    pairing.open()
    const expired = pairing.create(false, 'TV')
    now += 300_000
    assert.throws(() => pairing.inspect(expired.code))
    assert.throws(() => pairing.create(false, 'TV'))
  })
  it('bounds the total pending requests', () => {
    const pairing = new WebPairing()
    pairing.open()
    for (let i = 0; i < 20; i++) pairing.create(false, 'TV')
    assert.throws(() => pairing.create(false, 'TV'))
  })
})
describe('Remembered browser lifecycle', () => {
  it('persists only remembered hashes, retains deadlines over restart and revokes individual devices', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-device-'))
    try {
      const file = path.join(dir, 'devices.json')
      let now = 0
      let sessions = new WebSessions(() => now, file)
      const remembered = sessions.create(true, 'TV')
      const temporary = sessions.create(false, 'guest')
      assert.ok(!fs.readFileSync(file, 'utf8').includes(remembered))
      assert.ok(!fs.readFileSync(file, 'utf8').includes(temporary))
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
      sessions.suspend()
      sessions = new WebSessions(() => now, file)
      assert.equal(sessions.check(remembered), true)
      assert.equal(sessions.check(temporary), false)
      for (let halfDay = 1; halfDay <= 14; halfDay++) {
        now += 12 * 60 * 60_000
        sessions = new WebSessions(() => now, file)
        assert.equal(sessions.check(remembered), halfDay < 14)
      }
      const a = sessions.create(true, 'A')
      const b = sessions.create(true, 'B')
      sessions.remove(sessions.list().find((x) => x.name === 'A')!.id)
      sessions = new WebSessions(() => now, file)
      assert.equal(sessions.check(a), false)
      assert.equal(sessions.check(b), true)
      sessions.revoke(b)
      sessions = new WebSessions(() => now, file)
      assert.equal(sessions.check(b), false)
      const idle = sessions.create(true, 'idle')
      now += 24 * 60 * 60_000
      assert.equal(new WebSessions(() => now, file).check(idle), false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Pairing HTTP boundary', () => {
  it('binds exchange to a private cookie, keeps approval desktop-only and remembers across server restarts', async () => {
    const { WebServer } = await import('./server')
    const { hashPassword } = await import('./auth')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-pair-http-'))
    const sessions = new WebSessions(Date.now, path.join(dir, 'devices.json'))
    const server = new WebServer({
      sessions,
      username: 'viewer',
      passwordHash: await hashPassword('test password 123'),
      staticRoot: dir,
      catalog: {
        collections: () => ({ libraries: [], playlists: [] }),
        browse: () => ({ items: [], total: 0, page: 1, pageSize: 36 }),
        detail: () => {
          throw new Error()
        },
        image: () => {
          throw new Error()
        },
        media: () => {
          throw new Error()
        }
      }
    })
    let base = `http://127.0.0.1:${await server.start(0, '127.0.0.1')}`
    const post = (route: string, body = {}, cookie = '', origin = base) =>
      fetch(base + route, {
        method: 'POST',
        headers: {
          Origin: origin,
          'X-Javdex-Client': 'web',
          'Content-Type': 'application/json',
          Cookie: cookie
        },
        body: JSON.stringify(body)
      })
    try {
      assert.equal((await post('/api/pair/start')).status, 400)
      server.pairing.open()
      assert.equal(
        (await post('/api/pair/start', {}, '', 'http://evil.test')).status,
        403
      )
      const started = await post('/api/pair/start', {
        name: 'TV',
        remember: true
      })
      assert.equal(started.status, 200)
      const cookie = started.headers.get('set-cookie')!.split(';')[0]
      assert.match(
        started.headers.get('set-cookie')!,
        /HttpOnly; SameSite=Strict/
      )
      const body = (await started.json()) as { code: string; secret?: string }
      assert.equal(body.secret, undefined)
      assert.equal(
        (await post('/api/pair/poll', {}, `javdex_pair=${body.code}`)).status,
        400
      )
      assert.equal(
        (await post('/api/pair/approve', { code: body.code })).status,
        405
      )
      server.pairing.decide(body.code, true)
      const paired = await post('/api/pair/poll', {}, cookie)
      assert.equal(paired.status, 200)
      assert.equal(((await paired.json()) as { authenticated: boolean }).authenticated, true)
      const session = paired.headers.get('set-cookie')!.split(';')[0]
      assert.equal((await post('/api/pair/poll', {}, cookie)).status, 400)
      await server.stop()
      base = `http://127.0.0.1:${await server.start(0, '127.0.0.1')}`
      assert.equal(
        (await fetch(base + '/api/session', { headers: { Cookie: session } }))
          .status,
        200
      )
      assert.equal((await post('/api/videos/1', {}, session)).status, 405)
      await post('/api/logout', {}, session)
      assert.equal(
        (await fetch(base + '/api/session', { headers: { Cookie: session } }))
          .status,
        401
      )
      assert.equal(
        new WebSessions(Date.now, path.join(dir, 'devices.json')).count(),
        0
      )
    } finally {
      await server.stop()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
