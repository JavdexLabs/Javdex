import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { request } from 'node:http'
import { hashPassword, LoginLimiter, verifyPassword, WebSessions } from './auth'
import { parseRange } from './http'
import { isLocalPeer, WebServer } from './server'
import type { WebCatalogReader } from './catalog'
import { AssetReadQueueFullError, AssetReadTooLargeError, AssetPixelLimitError } from '../services/mediaAssetStore'

describe('Web authentication and streaming', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-web-'))
  const movie = path.join(directory, 'movie.mp4')
  const bytes = Buffer.from('0123456789abcdef')
  let server: WebServer
  let base: string
  let sessionCookie: string
  let passwordHash: string
  const catalog: WebCatalogReader = {
    home: () => ({ discovery: [], recent: [] }),
    collections: () => ({ libraries: [], playlists: [] }),
    browse: () => ({ items: [], total: 0, page: 1, pageSize: 36 }),
    detail: () => {
      throw new Error('not found')
    },
    image: async () => ({ body: Buffer.from('image'), mime: 'image/png' }),
    media: () => ({ file: movie, stat: fs.statSync(movie), mime: 'video/mp4' })
  }
  const login = (password = 'correct horse battery'): Promise<Response> =>
    fetch(`${base}/api/login`, {
      method: 'POST',
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-Javdex-Client': 'web'
      },
      body: JSON.stringify({ username: 'viewer', password })
    })
  before(async () => {
    fs.writeFileSync(movie, bytes)
    fs.mkdirSync(path.join(directory, 'assets'))
    for (const size of [32, 128]) {
      fs.copyFileSync(
        path.resolve(`build/icon-${size}.png`),
        path.join(directory, 'assets', `icon-${size}-test.png`)
      )
    }
    fs.writeFileSync(
      path.join(directory, 'index.html'),
      '<!doctype html><title>Login</title>'
    )
    passwordHash = await hashPassword('correct horse battery')
    server = new WebServer({
      username: 'viewer',
      passwordHash,
      staticRoot: directory,
      catalog
    })
    base = `http://127.0.0.1:${await server.start(0, '127.0.0.1')}`
    const response = await login()
    sessionCookie = response.headers.get('set-cookie')!.split(';')[0]
    assert.equal(response.status, 200)
  })
  after(async () => {
    await server.stop()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  it('keeps image responses private and reports read queue overload as 503', async (t) => {
    t.mock.method(catalog, 'image', async () => { throw new AssetReadQueueFullError() })
    for (const method of ['GET', 'HEAD']) {
      const result = await fetch(base + '/api/videos/1/images/cover', { method, headers: { Cookie: sessionCookie } })
      assert.equal(result.status, 503)
      assert.equal(result.headers.get('cache-control'), 'no-store')
      if (method === 'HEAD') assert.equal(await result.text(), '')
    }
  })

  it('forwards finite thumbnail sizes and rejects invalid sizes before image work', async (t) => {
    const image = t.mock.method(catalog, 'image', async (_id: number, _key: string, _signal?: AbortSignal, size?: number) => {
      assert.equal(size, 640)
      return { body: Buffer.from('thumbnail'), mime: 'image/webp' }
    })
    const result = await fetch(base + '/api/videos/1/images/cover?size=640', { headers: { Cookie: sessionCookie } })
    assert.equal(result.status, 200)
    assert.equal(result.headers.get('content-type'), 'image/webp')
    const bad = await fetch(base + '/api/videos/1/images/cover?size=0', { headers: { Cookie: sessionCookie } })
    assert.equal(bad.status, 400)
    assert.equal(image.mock.callCount(), 1)
  })

  it('reports oversized images as 413 without caching or a HEAD body', async (t) => {
    for (const Failure of [AssetReadTooLargeError, AssetPixelLimitError]) for (const method of ['GET', 'HEAD']) {
      t.mock.method(catalog, 'image', async () => { throw new Failure() })
      const result = await fetch(base + '/api/videos/1/images/cover', { method, headers: { Cookie: sessionCookie } })
      assert.equal(result.status, 413)
      assert.equal(result.headers.get('cache-control'), 'no-store')
      if (method === 'HEAD') assert.equal(await result.text(), '')
    }
  })

  it('rechecks an expired session after image work while the connection remains open', async (t) => {
    let clock = Date.now()
    t.mock.method(Date, 'now', () => clock)
    let started!: () => void
    let release!: () => void
    let readSignal: AbortSignal | undefined
    const began = new Promise<void>((resolve) => { started = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const isolated = new WebServer({
      username: 'viewer', passwordHash, staticRoot: directory,
      catalog: { ...catalog, image: async (_id, _key, signal) => {
        readSignal = signal
        started()
        await gate
        return { body: Buffer.from('private image'), mime: 'image/png' }
      } }
    })
    try {
      const origin = `http://127.0.0.1:${await isolated.start(0, '127.0.0.1')}`
      const loginResponse = await fetch(origin + '/api/login', {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Javdex-Client': 'web' },
        body: JSON.stringify({ username: 'viewer', password: 'correct horse battery' })
      })
      assert.equal(loginResponse.status, 200)
      const cookie = loginResponse.headers.get('set-cookie')!.split(';')[0]
      const response = fetch(origin + '/api/videos/1/images/cover', { headers: { Cookie: cookie } })
      await began
      clock += 15 * 24 * 60 * 60 * 1000
      assert.equal(readSignal?.aborted, false)
      release()
      const result = await response
      assert.equal(result.status, 401)
      assert.doesNotMatch(await result.text(), /private image/)
    } finally {
      release()
      await isolated.stop()
    }
  })

  for (const reason of ['logout', 'disconnect'] as const) {
    it(`cancels pending image work on ${reason} and never sends its completed bytes`, async (t) => {
      const cookie = (await login()).headers.get('set-cookie')!.split(';')[0]
      let started!: () => void
      let cancelled!: () => void
      let release!: () => void
      const began = new Promise<void>((resolve) => { started = resolve })
      const aborted = new Promise<void>((resolve) => { cancelled = resolve })
      const gate = new Promise<void>((resolve) => { release = resolve })
      t.mock.method(catalog, 'image', async (_id: number, _key: string, signal?: AbortSignal) => {
        signal?.addEventListener('abort', cancelled, { once: true })
        started()
        await gate
        return { body: Buffer.from('private image'), mime: 'image/png' }
      })
      const controller = new AbortController()
      const result = fetch(base + '/api/videos/1/images/cover', {
        headers: { Cookie: cookie }, signal: controller.signal
      }).then(async (response) => ({ status: response.status, body: await response.text() }), () => ({ status: 0, body: '' }))
      try {
        await began
        if (reason === 'logout') {
          const loggedOut = await fetch(base + '/api/logout', {
            method: 'POST', headers: { Cookie: cookie, Origin: base, 'X-Javdex-Client': 'web' }
          })
          assert.equal(loggedOut.status, 200)
        } else controller.abort()
        await aborted
        release()
        const response = await result
        assert.notEqual(response.status, 200)
        assert.notEqual(response.body, 'private image')
      } finally {
        release()
        controller.abort()
        await result
      }
    })
  }
  it('stores salted password hashes and enforces minimum length', async () => {
    assert.equal(await verifyPassword('wrong password', passwordHash), false)
    assert.equal(
      await verifyPassword('correct horse battery', passwordHash),
      true
    )
    assert.notEqual(await hashPassword('correct horse battery'), passwordHash)
    await assert.rejects(hashPassword('short'))
  })
  it('requires a session for catalog, artwork, and video, with no credential data in failures', async () => {
    for (const route of [
      '/api/session',
      '/api/videos',
      '/api/collections',
      '/api/home',
      '/api/videos/1/images/cover',
      '/api/videos/1/images/actress-1',
      '/api/videos/1/media/1'
    ]) {
      const result = await fetch(base + route)
      assert.equal(result.status, 401, route)
      assert.equal(result.headers.get('cache-control'), 'no-store')
      assert.doesNotMatch(await result.text(), /password|token|locator/)
    }
    assert.equal((await fetch(base + '/')).status, 200)
  })
  it('serves brand and favicon PNGs without login with the correct MIME and bytes', async () => {
    for (const size of [32, 128]) {
      const url = `${base}/assets/icon-${size}-test.png`
      const expected = fs.readFileSync(path.resolve(`build/icon-${size}.png`))
      const response = await fetch(url)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'image/png')
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected)
      const head = await fetch(url, { method: 'HEAD' })
      assert.equal(head.status, 200)
      assert.equal(head.headers.get('content-type'), 'image/png')
      assert.equal(Number(head.headers.get('content-length')), expected.length)
      assert.equal(await head.text(), '')
    }
    for (const route of ['/assets/index.js.map', '/build/icon-32.png', '/assets/nested/icon.png']) {
      assert.equal((await fetch(base + route)).status, 404)
    }
  })
  it('rejects bad credentials; issues HttpOnly SameSite cookies on login', async () => {
    assert.equal((await login('not the password')).status, 401)
    const response = await login()
    assert.match(
      response.headers.get('set-cookie')!,
      /HttpOnly; SameSite=Strict/
    )
    const cookie = response.headers.get('set-cookie')!.split(';')[0]
    const session = await fetch(base + '/api/session', {
      headers: { Cookie: cookie }
    })
    assert.deepEqual(await session.json(), {
      authenticated: true,
      username: 'viewer'
    })
  })
  it('blocks cross-origin, missing-origin POSTs, DNS rebinding, and desktop mutation routes', async () => {
    const crossSiteHeaders: Record<string, string>[] = [
      { Origin: 'https://evil.example' },
      { 'Sec-Fetch-Site': 'cross-site' }
    ]
    for (const headers of crossSiteHeaders) {
      assert.equal(
        (
          await fetch(base + '/api/videos', {
            headers: { Cookie: sessionCookie, ...headers }
          })
        ).status,
        403
      )
    }
    assert.equal(
      (await fetch(base + '/api/login', { method: 'POST' })).status,
      403
    )
    assert.equal(
      (
        await fetch(base + '/api/videos/1', {
          method: 'DELETE',
          headers: { Cookie: sessionCookie }
        })
      ).status,
      405
    )
    assert.equal(
      (
        await fetch(base + '/api/settings', {
          method: 'POST',
          headers: {
            Cookie: sessionCookie,
            Origin: base,
            'X-Javdex-Client': 'web'
          }
        })
      ).status,
      405
    )
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        base + '/',
        { headers: { Host: 'evil.example' } },
        (res) => {
          res.resume()
          resolve(res.statusCode)
        }
      )
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 403)
    assert.equal(
      (
        await fetch(base + '/package.json', {
          headers: { Cookie: sessionCookie }
        })
      ).status,
      404
    )
    assert.equal(
      (await fetch(base + '/assets/../../web-access.json')).status,
      404
    )
  })
  it('streams byte ranges, suffixes and HEAD; rejects invalid or multiple ranges', async () => {
    const media = base + '/api/videos/1/media/1'
    const part = await fetch(media, {
      headers: { Cookie: sessionCookie, Range: 'bytes=3-7' }
    })
    assert.equal(part.status, 206)
    assert.equal(part.headers.get('content-range'), 'bytes 3-7/16')
    assert.equal(await part.text(), '34567')
    const suffix = await fetch(media, {
      headers: { Cookie: sessionCookie, Range: 'bytes=-3' }
    })
    assert.equal(await suffix.text(), 'def')
    const head = await fetch(media, {
      method: 'HEAD',
      headers: { Cookie: sessionCookie }
    })
    assert.equal(head.headers.get('content-length'), '16')
    assert.equal(await head.text(), '')
    for (const range of ['bytes=20-', 'bytes=0-1,3-4', 'bytes=-0']) {
      const result = await fetch(media, {
        headers: { Cookie: sessionCookie, Range: range }
      })
      assert.equal(result.status, 416)
      assert.equal(result.headers.get('content-range'), 'bytes */16')
    }
  })
  it('downloads authenticated resources as attachments', async () => {
    const response = await fetch(base + '/api/videos/1/media/1?download=1', { headers: { Cookie: sessionCookie } })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''/)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    assert.equal((await fetch(base + '/api/videos/1/media/1?download=1')).status, 401)
  })
  it('logout invalidates the cookie; desktop revocation invalidates all browsers', async () => {
    const fresh = await login()
    const cookie = fresh.headers.get('set-cookie')!.split(';')[0]
    assert.equal(
      (
        await fetch(base + '/api/logout', {
          method: 'POST',
          headers: { Cookie: cookie, Origin: base, 'X-Javdex-Client': 'web' }
        })
      ).status,
      200
    )
    assert.equal(
      (await fetch(base + '/api/session', { headers: { Cookie: cookie } }))
        .status,
      401
    )
    server.revokeSessions()
    // Revocation deliberately closes existing sockets, including fetch's idle pool.
    // Use a fresh connection to test the old cookie rather than race that close.
    const revokedStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(base + '/api/session', { agent: false, headers: { Cookie: sessionCookie } }, res => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(revokedStatus, 401)
  })
})

describe('Session lifetimes and request limits', () => {
  it('expires idle and absolute sessions and limits attempts', () => {
    let now = 0
    const sessions = new WebSessions(() => now)
    const idle = sessions.create()
    now += 24 * 60 * 60_000
    assert.equal(sessions.check(idle), false)
    const active = sessions.create()
    for (let day = 0; day < 14; day++) {
      now += 12 * 60 * 60_000
      assert.equal(sessions.check(active), day < 13)
    }
    const limiter = new LoginLimiter(() => now)
    for (let i = 0; i < 8; i++) {
      const release = limiter.enter('peer')
      assert.ok(release)
      release()
    }
    assert.equal(limiter.enter('peer'), null)
    now += 15 * 60_000
    assert.ok(limiter.enter('peer'))
  })
  it('accepts only local peer ranges and handles byte-range edge cases', () => {
    for (const ip of [
      '127.0.0.1',
      '192.168.1.4',
      '10.1.2.3',
      '172.16.1.1',
      '::ffff:192.168.2.1',
      '::1',
      'fd00::1'
    ])
      assert.ok(isLocalPeer(ip), ip)
    for (const ip of [
      '8.8.8.8',
      '172.32.1.1',
      '192.169.0.1',
      'example.com',
      '2001:4860::1'
    ])
      assert.equal(isLocalPeer(ip), false)
    assert.deepEqual(parseRange('bytes=0-999', 10), { start: 0, end: 9 })
    assert.throws(() => parseRange('bytes=0-', 0))
    assert.equal(parseRange(undefined, 0), null)
  })
})
