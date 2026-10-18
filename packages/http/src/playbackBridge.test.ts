import assert from 'node:assert/strict'
import { test } from 'node:test'
import { request } from 'node:http'
import { Readable } from 'node:stream'
import { ReadableStream } from 'node:stream/web'
import { createPlaybackBridge } from './playbackBridge'
import type { PlayGrant } from '@shared/protocol/play'

const origin = 'https://fixture.invalid'
const expiresAt = (): string => new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()

// Exercise the actual loopback listener without Fetch's forbidden-port list:
// production players use native HTTP, while the OS may assign any available port.
const fetch = (url: string, init: RequestInit = {}): Promise<Response> => new Promise((resolve, reject) => {
  const outgoing = request(url, {
    method: init.method, headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal ?? undefined
  }, incoming => {
    const headers = new Headers()
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value != null) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    }
    const body = init.method === 'HEAD' ? null : Readable.toWeb(incoming) as ReadableStream
    if (!body) incoming.resume()
    resolve(new Response(body, { status: incoming.statusCode, headers }))
  })
  outgoing.once('error', reject)
  outgoing.end()
})

test('releasing old sessions allows over 64 video switches and preserves other readers', async t => {
  const bridge = createPlaybackBridge(origin, async (_url, options) => new Response(options?.method === 'HEAD' ? null : 'abc', {
    status: 206, headers: { 'Content-Length': '3', 'Content-Range': 'bytes 1-3/5', 'Content-Type': 'video/mp4' }
  }))
  t.after(() => bridge.close())
  let previous: string | undefined
  const independent = await bridge.grant(`${origin}/play/external`, expiresAt())
  for (let index = 0; index < 260; index++) {
    const next = await bridge.grant(`${origin}/play/${index}`, expiresAt(), { renew: async () => {
      throw new Error('unexpired routes must be reused')
    } })
    if (previous) bridge.release(previous)
    previous = next
  }
  const read = await fetch(previous!, { headers: { Range: 'bytes=1-3' } })
  assert.equal(read.status, 206)
  assert.equal(await read.text(), 'abc')
  bridge.release(previous!)
  assert.equal((await fetch(previous!)).status, 403)
  assert.equal((await fetch(independent, { method: 'HEAD' })).status, 206)

  const owned = { renew: async () => { throw new Error('not expired') } }
  for (let index = 0; index < 64; index++) await bridge.grant(`${origin}/play/held-${index}`, expiresAt(), owned)
  await assert.rejects(bridge.grant(`${origin}/play/overflow`, expiresAt(), owned), { code: 'PLAYBACK_BRIDGE_CAPACITY' })
  bridge.clear()
  assert.equal((await fetch(independent)).status, 403)
  await assert.doesNotReject(bridge.grant(`${origin}/play/reconnected`, expiresAt()))
})

test('external LRU eviction is bounded at 64 and independent of 64 owned sessions', async t => {
  const bridge = createPlaybackBridge(origin, async () => new Response('abc'))
  t.after(() => bridge.close())
  const owned = { renew: async () => { throw new Error('not expired') } }
  const native = await bridge.grant(`${origin}/play/native.mp4`, expiresAt(), owned)
  for (let index = 1; index < 64; index++) await bridge.grant(`${origin}/play/native-${index}.mp4`, expiresAt(), owned)
  const handles: string[] = []
  for (let index = 0; index < 64; index++) handles.push(await bridge.grant(`${origin}/play/external-${index}.mp4`, expiresAt()))
  await (await fetch(handles[0])).text() // Reading a URL makes it more recent than URL 1.
  handles.push(await bridge.grant(`${origin}/play/new.mp4`, expiresAt()))
  assert.equal((await fetch(handles[1])).status, 403)
  assert.equal((await fetch(handles[0], { method: 'HEAD' })).status, 200)
  assert.equal((await fetch(native, { method: 'HEAD' })).status, 200)
  for (let index = 65; index < 300; index++) handles.push(await bridge.grant(`${origin}/play/external-${index}.mp4`, expiresAt()))
  assert.equal((await fetch(handles[0])).status, 403)
  assert.equal((await fetch(handles[235])).status, 403)
  assert.equal((await fetch(handles[236], { method: 'HEAD' })).status, 200)
  assert.equal((await fetch(handles[299], { method: 'HEAD' })).status, 200)
  assert.equal((await fetch(native, { method: 'HEAD' })).status, 200)
})

test('external opens reuse one grant, coalesce issuance, retain the filename and replace only near expiry', async t => {
  let now = Date.now(), issued = 0
  let finish!: () => void
  const waiting = new Promise<void>(resolve => { finish = resolve })
  const bridge = createPlaybackBridge(origin, async () => new Response('abc'), () => now)
  t.after(() => bridge.close())
  const fileName = "中文 影片 (1)'s%.mp4"
  const issue = async (): Promise<PlayGrant> => {
    issued++; await waiting
    return { grantId: String(issued), resourceId: 1, playbackHandle: `${origin}/play/${encodeURIComponent(fileName)}?t=scoped`,
      expiresAt: new Date(now + 120_000).toISOString(), methods: ['HEAD', 'GET'], range: true }
  }
  const cancelled = new AbortController()
  const cancelledOpen = bridge.external('resource', issue, cancelled.signal).catch(() => null)
  const opens = Array.from({ length: 8 }, () => bridge.external('resource', issue))
  cancelled.abort(); finish()
  assert.equal(await cancelledOpen, null)
  const results = await Promise.all(opens)
  assert.equal(issued, 1)
  const handle = results[0].playbackHandle
  assert.ok(results.every(value => value.playbackHandle === handle))
  for (const result of results) bridge.finishExternal(result.playbackHandle, true)
  for (let index = 0; index < 260; index++) {
    const reused = await bridge.external('resource', issue)
    assert.equal(reused.playbackHandle, handle)
    bridge.finishExternal(reused.playbackHandle, false)
  }
  assert.equal(issued, 1)
  assert.equal(decodeURIComponent(new URL(handle).pathname.split('/').at(-1)!), fileName)
  const head = await fetch(handle, { method: 'HEAD' })
  assert.equal(decodeURIComponent(head.headers.get('content-disposition')!.split("UTF-8''")[1]), fileName)
  const reencoded = handle.replace(/'/g, '%27').replace(/%[A-F0-9]{2}/g, value => value.toLowerCase())
  assert.equal((await fetch(reencoded, { method: 'HEAD' })).status, 200)
  assert.equal(new URL(handle).search, '', 'the external URL must not reveal the upstream token')
  now += 61_000
  const next = await bridge.external('resource', issue)
  assert.notEqual(next.playbackHandle, handle)
  assert.equal(issued, 2)
  assert.equal((await fetch(handle, { method: 'HEAD' })).status, 200, 'already-open external readers keep their original expiry')
  const failed = await bridge.external('failed-launch', issue)
  bridge.finishExternal(failed.playbackHandle, false)
  assert.equal((await fetch(failed.playbackHandle)).status, 403, 'a new URL not accepted by the external player is discarded')
})

test('external reuse validates cached grants and coalesces invalidation and reissue before handoff', async t => {
  let issued = 0, revokedStatus = 0, checks = 0
  let checked!: () => void, finish!: () => void
  let waiting: Promise<void> | undefined
  const bridge = createPlaybackBridge(origin, async (url, options) => {
    assert.equal(options?.method, 'HEAD')
    checks++
    const status = revokedStatus
    checked?.()
    await waiting
    return new Response(null, { status: String(url).includes(`/grant-${issued}.mp4`) ? status || 200 : 404 })
  })
  t.after(() => bridge.close())
  const issue = async (): Promise<PlayGrant> => ({ grantId: String(++issued), resourceId: 1,
    playbackHandle: `${origin}/play/grant-${issued}.mp4?t=scoped`, expiresAt: expiresAt(), methods: ['HEAD', 'GET'], range: true })
  let previous = await bridge.external('resource', issue)
  bridge.finishExternal(previous.playbackHandle, true)
  for (const status of [401, 403, 404]) {
    revokedStatus = status
    let entered!: () => void
    const enteredCheck = new Promise<void>(resolve => { entered = resolve })
    checked = entered
    waiting = new Promise<void>(resolve => { finish = resolve })
    const before = issued, beforeChecks = checks
    const requests = Array.from({ length: 8 }, () => bridge.external('resource', issue))
    await enteredCheck
    finish()
    const results = await Promise.all(requests)
    assert.equal(issued, before + 1)
    assert.equal(checks, beforeChecks + 1)
    assert.ok(results.every(value => value.playbackHandle === results[0].playbackHandle))
    assert.notEqual(results[0].playbackHandle, previous.playbackHandle)
    assert.equal((await fetch(previous.playbackHandle)).status, 403, 'a dead cached proxy is removed before its replacement is handed off')
    for (const result of results) bridge.finishExternal(result.playbackHandle, true)
    previous = results[0]
  }
  const beforeClear = issued
  let entered!: () => void
  const enteredCheck = new Promise<void>(resolve => { entered = resolve })
  checked = entered
  waiting = new Promise<void>(resolve => { finish = resolve })
  revokedStatus = 0
  const checking = bridge.external('resource', issue)
  await enteredCheck
  bridge.clear()
  finish()
  await assert.rejects(checking)
  assert.equal(issued, beforeClear, 'a validation completing after disconnect cannot recreate the old route')
})

test('transient validation failures preserve cached external URLs and do not issue extra grants', async t => {
  let issued = 0, failure: 'network' | number = 200
  const bridge = createPlaybackBridge(origin, async () => {
    if (failure === 'network') throw new Error('synthetic network interruption')
    return new Response(null, { status: failure })
  })
  t.after(() => bridge.close())
  const issue = async (): Promise<PlayGrant> => ({ grantId: String(++issued), resourceId: 1,
    playbackHandle: `${origin}/play/movie.mp4`, expiresAt: expiresAt(), methods: ['HEAD', 'GET'], range: true })
  const original = await bridge.external('resource', issue)
  bridge.finishExternal(original.playbackHandle, true)
  for (failure of ['network', 500, 503] as const) {
    await assert.rejects(bridge.external('resource', issue), { code: 'PLAYBACK_BRIDGE_CLOSED' })
    assert.equal(issued, 1)
  }
  failure = 200
  const reused = await bridge.external('resource', issue)
  assert.equal(reused.playbackHandle, original.playbackHandle)
  assert.equal(issued, 1)
})

test('periodic expiry cleanup aborts an abandoned external stream without another open', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let now = Date.now()
  let aborted!: () => void
  const upstreamAborted = new Promise<void>(resolve => { aborted = resolve })
  const bridge = createPlaybackBridge(origin, async (_url, options) => {
    options?.signal?.addEventListener('abort', aborted, { once: true })
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])) } }))
  }, () => now)
  t.after(() => bridge.close())
  const handle = await bridge.grant(`${origin}/play/abandoned.mp4`, new Date(now + 1000).toISOString())
  const response = await fetch(handle)
  const failed = response.arrayBuffer().then(() => false, () => true)
  now += 1001
  t.mock.timers.tick(60_000)
  await upstreamAborted
  assert.equal(await failed, true)
  assert.equal((await fetch(handle)).status, 403)
})

test('a stable session URL coalesces renewal for decoder and subtitle Range requests, including after a long pause', async t => {
  let now = Date.now(), renewals = 0
  let finish!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const waiting = new Promise<void>(resolve => { finish = resolve })
  const upstreams: string[] = []
  const bridge = createPlaybackBridge(origin, async (url, options) => {
    upstreams.push(String(url))
    assert.equal(new Headers(options?.headers).get('range'), 'bytes=1-3')
    return new Response(options?.method === 'HEAD' ? null : 'abc', {
      status: 206, headers: { 'Content-Length': '3', 'Content-Range': 'bytes 1-3/5' }
    })
  }, () => now)
  t.after(() => bridge.close())
  const handle = await bridge.grant(`${origin}/play/initial`, new Date(now + 120_000).toISOString(), { renew: async () => {
    renewals++; entered(); await waiting
    return { url: `${origin}/play/renewed`, expiresAt: new Date(now + 12 * 60 * 60 * 1000).toISOString() }
  } })
  // A paused owner must survive pruning even when its previous upstream grant expired.
  now += 13 * 60 * 60 * 1000
  await bridge.grant(`${origin}/play/another`, new Date(now + 120_000).toISOString())
  const requests = ['GET', 'HEAD', 'GET'].map(method => fetch(handle, { method, headers: { Range: 'bytes=1-3' } }))
  await started
  finish()
  for (const response of await Promise.all(requests)) { assert.equal(response.status, 206); await response.arrayBuffer() }
  for (let index = 0; index < 140; index++) {
    const response = await fetch(handle, { headers: { Range: 'bytes=1-3' } })
    assert.equal(await response.text(), 'abc')
  }
  assert.equal(renewals, 1)
  assert.ok(upstreams.every(url => url === `${origin}/play/renewed`))
})

test('release aborts pending media and renewal; late authorization cannot resurrect a route', async t => {
  let finish!: (grant: { url: string; expiresAt: string }) => void
  let entered!: () => void
  let signal: AbortSignal | undefined
  let reads = 0
  const started = new Promise<void>(resolve => { entered = resolve })
  const bridge = createPlaybackBridge(origin, async () => { reads++; return new Response('abc') })
  t.after(() => bridge.close())
  const handle = await bridge.grant(`${origin}/play/old`, new Date(Date.now() + 1000).toISOString(), {
    renew: async value => { signal = value; entered(); return new Promise(resolve => { finish = resolve }) }
  })
  const request = fetch(handle).then(() => false, () => true)
  await started
  bridge.release(handle)
  assert.equal(signal?.aborted, true)
  assert.equal(await request, true, 'the old reader is terminated immediately')
  finish({ url: `${origin}/play/late`, expiresAt: expiresAt() })
  assert.equal((await fetch(handle)).status, 403)
  assert.equal(reads, 0)

  let reading!: () => void
  let aborted!: () => void
  const readStarted = new Promise<void>(resolve => { reading = resolve })
  const readAborted = new Promise<void>(resolve => { aborted = resolve })
  const streaming = createPlaybackBridge(origin, async (_url, options) => {
    options?.signal?.addEventListener('abort', aborted, { once: true })
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); reading() } }))
  })
  t.after(() => streaming.close())
  const stream = await streaming.grant(`${origin}/play/stream`, expiresAt())
  const response = await fetch(stream)
  const body = response.arrayBuffer().then(() => false, () => true)
  await readStarted
  streaming.release(stream)
  await readAborted
  assert.equal(await body, true)
})
