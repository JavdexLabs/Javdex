import assert from 'node:assert/strict'
import { afterEach, beforeEach, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabaseAtPath, closeDatabase } from '../db/database'
import { createWorkerWebCatalog } from './catalogWorkerAdapter'
import { WebServer } from './server'
import { WebSessions } from './auth'
import type { CatalogReadWorkerClient } from '../services/catalogReadWorkerClient'

let root: string
let previous: string | undefined
let server: WebServer | undefined
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-catalog-http-'))
  previous = process.env.JAVDEX_TEST_USER_DATA; process.env.JAVDEX_TEST_USER_DATA = root
})
afterEach(async () => {
  try { await server?.stop() } finally {
    server = undefined; closeDatabase()
    if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})
const empty = { items: [], total: 0, page: 1, pageSize: 36 }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function setup(reads: Pick<CatalogReadWorkerClient, 'readWebBrowse' | 'readWebHome' | 'readWebCollections'>, clock = Date.now) {
  const db = initDatabaseAtPath(path.join(root, 'catalog.db'))
  const sessions = new WebSessions(clock)
  const cookie = `javdex_web_session=${sessions.create()}`
  server = new WebServer({ username: 'reader', passwordHash: 'unused', staticRoot: root,
    catalog: createWorkerWebCatalog(db, reads), sessions })
  const base = `http://127.0.0.1:${await server.start(0, '127.0.0.1')}`
  return { base, cookie }
}
function readers() {
  return { readWebBrowse: async () => empty, readWebHome: async () => ({ discovery: [], recent: [] }),
    readWebCollections: async () => ({ libraries: [], playlists: [] }) }
}
it('rejects invalid Web requests as 400 before dispatch and reports reader failures as 503', async () => {
  let calls = 0
  const { base, cookie } = await setup({ ...readers(), readWebBrowse: async () => { calls++; throw new Error('capacity exceeded') } })
  for (const query of ['page=0', 'page=1.5', 'sort=unknown', 'library=-1', 'q=' + 'x'.repeat(201)]) {
    const response = await fetch(`${base}/api/videos?${query}`, { headers: { Cookie: cookie } })
    assert.equal(response.status, 400)
  }
  assert.equal((await fetch(`${base}/api/home?seed=`, { headers: { Cookie: cookie } })).status, 400)
  assert.equal(calls, 0)
  const response = await fetch(`${base}/api/videos`, { headers: { Cookie: cookie } })
  assert.equal(response.status, 503); assert.equal(calls, 1)
  assert.equal(response.headers.get('cache-control'), 'no-store')
})
for (const route of ['videos', 'home', 'collections'] as const) {
  it(`rechecks session expiry after awaited ${route}, without destroying the connection`, async () => {
    let clock = Date.now()
    const started = deferred(), gate = deferred()
    let signal: AbortSignal | undefined
    async function hold(incoming?: AbortSignal) { signal = incoming; started.resolve(); await gate.promise }
    const { base, cookie } = await setup({
      readWebBrowse: async (_query, incoming) => { await hold(incoming); return { ...empty, total: 98765 } },
      readWebHome: async (_seed, incoming) => { await hold(incoming); return { discovery: [], recent: [] } },
      readWebCollections: async incoming => { await hold(incoming); return { libraries: [], playlists: [] } }
    }, () => clock)
    const pending = fetch(`${base}/api/${route}`, { headers: { Cookie: cookie } })
    try {
      await Promise.race([started.promise, pending.then(() => { throw new Error('read not reached') })])
      assert.equal(signal?.aborted, false)
      clock += 15 * 24 * 60 * 60 * 1000
      gate.resolve()
      const response = await pending
      assert.equal(response.status, 401)
      assert.doesNotMatch(await response.text(), /98765|discovery|libraries/)
    } finally { gate.resolve(); await pending.catch(() => {}) }
  })
}
for (const reason of ['disconnect', 'logout', 'stop'] as const) {
  it(`releases the catalog subscription on ${reason} and never sends late results`, async () => {
    const started = deferred(), aborted = deferred(), gate = deferred()
    const { base, cookie } = await setup({ ...readers(), readWebBrowse: async (_query, signal) => {
      signal!.addEventListener('abort', aborted.resolve, { once: true })
      started.resolve(); await gate.promise
      return { ...empty, total: 98765 }
    } })
    const controller = new AbortController()
    const pending = fetch(`${base}/api/videos`, { headers: { Cookie: cookie }, signal: controller.signal })
      .then(async response => ({ status: response.status, body: await response.text() }), () => ({ status: 0, body: '' }))
    try {
      await Promise.race([started.promise, pending.then(() => { throw new Error('read not reached') })])
      if (reason === 'disconnect') controller.abort()
      else if (reason === 'stop') await server!.stop()
      else assert.equal((await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'X-Javdex-Client': 'web' } })).status, 200)
      await aborted.promise
      gate.resolve()
      const result = await pending
      assert.notEqual(result.status, 200); assert.doesNotMatch(result.body, /98765/)
    } finally { gate.resolve(); controller.abort(); await pending }
  })
}
