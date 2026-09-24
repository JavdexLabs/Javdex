import { describe, it, mock } from 'node:test'
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
  it('persists only remembered hashes, retains authorization over restart and revokes individual devices', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-device-'))
    try {
      const file = path.join(dir, 'devices.json')
      let now = 0
      let sessions = new WebSessions(() => now, file)
      const remembered = sessions.create(true, 'TV')
      const temporary = sessions.create(false, 'guest')
      assert.ok(!fs.readFileSync(file, 'utf8').includes(remembered))
      assert.ok(!fs.readFileSync(file, 'utf8').includes(temporary))
      // Windows stat mode does not represent POSIX owner/group permissions.
      if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
      sessions.suspend()
      sessions = new WebSessions(() => now, file)
      assert.equal(sessions.check(remembered), true)
      assert.equal(sessions.check(temporary), false)
      for (let halfDay = 1; halfDay <= 14; halfDay++) {
        now += 12 * 60 * 60_000
        sessions = new WebSessions(() => now, file)
        assert.equal(sessions.check(remembered), true)
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
      now += 3650 * 24 * 60 * 60_000
      const restored = new WebSessions(() => now, file)
      assert.equal(restored.check(idle), true)
      assert.equal(restored.list().find(x => x.name === 'idle')!.expires, null)
      restored.clear()
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
        home: () => ({ discovery: [], recent: [] }),
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
        410
      )
      assert.equal(
        (await post('/api/pair/approve', { code: body.code })).status,
        405
      )
      server.pairing.decide(body.code, true)
      const paired = await post('/api/pair/poll', {}, cookie)
      assert.equal(paired.status, 200)
      assert.equal(
        ((await paired.json()) as { authenticated: boolean }).authenticated,
        true
      )
      assert.match(paired.headers.get('set-cookie')!, /Max-Age=31536000/)
      const session = paired.headers.get('set-cookie')!.split(';')[0]
      const refreshed = await fetch(base + '/api/session', { headers: { Cookie: session } })
      assert.match(refreshed.headers.get('set-cookie')!, /Max-Age=31536000/)
      const retry = await post('/api/pair/poll', {}, cookie)
      assert.equal(retry.status, 200)
      assert.equal(retry.headers.get('set-cookie')!.split(';')[0], session)
      assert.equal(sessions.count(), 1)
      assert.equal(server.pairing.activity()[0].state, 'connected')
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

describe('Device record recovery', () => {
  it('keeps valid sessions usable during activity write failures and retries persistence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-activity-fault-'))
    const file = path.join(dir, 'devices.json')
    let now = 0
    try {
      const sessions = new WebSessions(() => now, file)
      const remembered = sessions.create(true, 'TV')
      const temporary = sessions.create(false, 'guest')
      const failure = mock.method(fs, 'renameSync', () => { throw new Error('ENOSPC') })
      const warning = mock.method(console, 'warn', () => {})
      try {
        now = 60_001
        assert.equal(sessions.check(remembered), true)
        assert.equal(sessions.check(temporary), true)
        assert.equal(sessions.check('invalid'), false)
        assert.ok(sessions.list().every(row => row.touched === now))
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].touched, 0)
        // Keep temporary idle expiry based on real activity even while storage is unavailable.
        for (let hour = 0; hour < 25; hour++) {
          now += 60 * 60_000
          assert.equal(sessions.check(temporary), true)
        }
        assert.throws(() => sessions.revoke(remembered), /操作未生效/)
      } finally {
        failure.mock.restore()
        warning.mock.restore()
      }
      now += 60_001
      assert.equal(sessions.check(remembered), true)
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].touched, now)
      assert.equal(new WebSessions(() => now, file).check(remembered), true)
      assert.equal(new WebSessions(() => now, file).check(temporary), false)
      now = 7 * 24 * 60 * 60_000
      assert.equal(sessions.check(temporary), false)
      sessions.revoke(remembered)
      assert.equal(sessions.check(remembered), false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  it('keeps disk and memory consistent after failed revoke, clear, rename and create', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-write-fault-'))
    const file = path.join(dir, 'devices.json')
    try {
      const sessions = new WebSessions(Date.now, file)
      const token = sessions.create(true, 'TV')
      const before = sessions.list()
      const failure = mock.method(fs, 'renameSync', () => {
        throw new Error('ENOSPC')
      })
      try {
        for (const action of [
          () => sessions.revoke(token),
          () => sessions.remove(before[0].id),
          () => sessions.clear(),
          () => sessions.rename(before[0].id, 'new'),
          () => sessions.create(true, 'new')
        ]) {
          assert.throws(action, /操作未生效/)
          assert.deepEqual(sessions.list(), before)
          assert.equal(new WebSessions(Date.now, file).check(token), true)
        }
      } finally {
        failure.mock.restore()
      }
      sessions.rename(before[0].id, '客厅电视')
      assert.equal(new WebSessions(Date.now, file).list()[0].name, '客厅电视')
      sessions.revoke(token)
      assert.equal(new WebSessions(Date.now, file).check(token), false)
      assert.deepEqual(fs.readdirSync(dir), ['devices.json'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  it('resets a damaged snapshot without parsing it or retaining old authorization', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-corrupt-'))
    const file = path.join(dir, 'devices.json')
    try {
      fs.writeFileSync(file, '{broken')
      assert.throws(() => new WebSessions(Date.now, file))
      const sessions = WebSessions.reset(file)
      assert.equal(sessions.count(), 0)
      if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
      const token = sessions.create(true, 'recovered')
      assert.equal(new WebSessions(Date.now, file).check(token), true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  it('restores remaining pairing time from server and retains approval on issuance failure', () => {
    let now = 0
    const pair = new WebPairing(() => now)
    pair.open()
    const request = pair.create(true, 'TV')
    now += 20_000
    assert.equal(pair.status(request.secret).remainingMs, 280_000)
    pair.decide(request.code, true)
    assert.equal(pair.status(request.secret).remainingMs, 60_000)
    assert.throws(() =>
      pair.poll(request.secret, () => {
        throw new Error('disk full')
      })
    )
    now += 5000
    assert.equal(pair.poll(request.secret)?.name, 'TV')
    assert.throws(() => pair.poll(request.secret))
  })
})

describe('Per-device streaming revocation', () => {
  it('interrupts the revoked stream while another browser finishes its stream', async () => {
    const { WebServer } = await import('./server')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-isolation-'))
    const movie = path.join(dir, 'movie.mp4')
    fs.writeFileSync(movie, Buffer.alloc(16 * 1024 * 1024))
    const sessions = new WebSessions()
    const first = sessions.create(false, 'A')
    const second = sessions.create(false, 'B')
    const server = new WebServer({
      sessions,
      username: 'viewer',
      passwordHash: '',
      staticRoot: dir,
      catalog: {
        home: () => ({ discovery: [], recent: [] }),
        collections: () => ({ libraries: [], playlists: [] }),
        browse: () => ({ items: [], total: 0, page: 1, pageSize: 36 }),
        detail: () => {
          throw new Error()
        },
        image: () => {
          throw new Error()
        },
        media: () => ({
          file: movie,
          stat: fs.statSync(movie),
          mime: 'video/mp4'
        })
      }
    })
    const base = `http://127.0.0.1:${await server.start(0, '127.0.0.1')}`
    try {
      const a = await fetch(base + '/api/videos/1/media/1', {
        headers: { Cookie: `javdex_web_session=${first}` }
      })
      const b = await fetch(base + '/api/videos/1/media/1', {
        headers: { Cookie: `javdex_web_session=${second}` }
      })
      server.removeDevice(sessions.list().find((x) => x.name === 'A')!.id)
      await assert.rejects(a.arrayBuffer())
      assert.equal((await b.arrayBuffer()).byteLength, 16 * 1024 * 1024)
      assert.equal(sessions.check(second), true)
    } finally {
      await server.stop()
      // Let pending stream close callbacks release Windows file handles.
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})
