import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import sharp, { type Sharp } from 'sharp'
import type { FileHandle } from 'node:fs/promises'
import { invalidateAssetCache } from './assetCache'
import { getPathAlias } from './assetPathAliases'
import { isOpaqueEncFilename } from './assetPathNaming'
import { MediaAssetStore, mediaAssetStore, AssetReadTooLargeError, MAX_ASSET_READ_BYTES, AssetPixelLimitError } from './mediaAssetStore'
import { encryptPlain, resetAssetKeyCacheForTests } from './assetCrypto'

const JPEG_1X1 = Buffer.from(
  'ffd8ffdb00430006040506050406060506070706080a100a0a09090a140e0f0c1017141818171416161a1d251f1a1b231c1616202c20232627292a29191f2d302d283025282928ffdb0043010707070a080a130a0a13281a161a2828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828282828ffc00011080001000103012200021101031101ffc40014000100000000000000000000000000000000ffc40014100100000000000000000000000000000000ffc40014010100000000000000000000000000000000ffc40014110100000000000000000000000000000000ffda000c03010002110311003f00000fffd9',
  'hex'
)

let root: string | null = null

function setup(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-media-store-'))
  process.env.JAVDEX_TEST_USER_DATA = root
  return root
}

afterEach(() => {
  invalidateAssetCache()
  resetAssetKeyCacheForTests()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = null
  delete process.env.JAVDEX_TEST_USER_DATA
})

describe('MediaAssetStore', () => {
  it('coalesces encrypted thumbnails, isolates size variants and preserves original preview bytes', async (t) => {
    setup()
    mediaAssetStore.importAvatarDisplay('Thumbnail', 1, JPEG_1X1)
    const input = await sharp({ create: { width: 1600, height: 800, channels: 3, background: '#804040' } }).png().toBuffer()
    const rel = 'avatars/thumb.enc'
    fs.writeFileSync(mediaAssetStore.resolve(rel), encryptPlain(input, '.png'))
    const opens = t.mock.method(fs.promises, 'open')
    const decodes = t.mock.method(sharp.prototype, 'toBuffer')
    const results = await Promise.all(Array.from({ length: 12 }, () => mediaAssetStore.readForServeAsync(rel, undefined, 640)))
    assert.equal(opens.mock.callCount(), 1)
    assert.equal(decodes.mock.callCount(), 1)
    assert.ok(results.every(image => image.mime === 'image/webp' && image.body.equals(results[0].body)))
    const dimensions = await sharp(results[0].body).metadata()
    assert.equal(dimensions.width, 640)
    assert.equal(dimensions.height, 320)
    const small = await mediaAssetStore.readForServeAsync(rel, undefined, 320)
    assert.equal((await sharp(small.body).metadata()).width, 320)
    assert.deepEqual((await mediaAssetStore.readForServeAsync(rel)).body, input)
    invalidateAssetCache(rel)
    await mediaAssetStore.readForServeAsync(rel, undefined, 640)
    assert.equal(decodes.mock.callCount(), 3)
    const replacement = await sharp({ create: { width: 800, height: 1600, channels: 3, background: '#408040' } }).png().toBuffer()
    fs.writeFileSync(mediaAssetStore.resolve(rel), encryptPlain(replacement, '.png'))
    const changed = await sharp((await mediaAssetStore.readForServeAsync(rel, undefined, 640)).body).metadata()
    assert.equal(changed.width, 320)
    assert.equal(changed.height, 640)
  })
  it('checks plain and decrypted image pixels before caching and recovers after replacement', async (t) => {
    setup()
    mediaAssetStore.importAvatarDisplay('PixelLimit', 1, JPEG_1X1)
    const oversized = Buffer.from(JPEG_1X1)
    const frame = oversized.indexOf(Buffer.from([0xff, 0xc0]))
    assert.ok(frame > 0)
    oversized.writeUInt16BE(8193, frame + 5)
    oversized.writeUInt16BE(8192, frame + 7)
    const metadata = t.mock.method(sharp.prototype, 'metadata')
    for (const ext of ['jpg', 'enc']) {
      const rel = `avatars/pixel-limit.${ext}`
      const save = (body: Buffer) => fs.writeFileSync(mediaAssetStore.resolve(rel), ext === 'enc' ? encryptPlain(body, '.jpg') : body)
      save(oversized)
      await assert.rejects(mediaAssetStore.readForServeAsync(rel), AssetPixelLimitError)
      await assert.rejects(mediaAssetStore.readForServeAsync(rel), AssetPixelLimitError)
      save(JPEG_1X1)
      assert.deepEqual((await mediaAssetStore.readForServeAsync(rel)).body, JPEG_1X1)
      const calls = metadata.mock.callCount()
      await mediaAssetStore.readForServeAsync(rel)
      assert.equal(metadata.mock.callCount(), calls, 'warm cache does not inspect headers again')
    }
  })
  for (const stage of ['read', 'close', 'metadata'] as const) {
    it(`retains cancelled active slots until file ${stage} settles`, { timeout: 5000 }, async (t) => {
      setup()
      const rels = Array.from({ length: 5 }, (_, i) => mediaAssetStore.importAvatarDisplay(`Drain${i}`, i + 1, JPEG_1X1))
      const stats = t.mock.method(fs.promises, 'stat')
      const original = fs.promises.open
      const handles: FileHandle[] = []
      let release!: () => void
      let entered!: () => void
      let waiting = 0
      const gate = new Promise<void>((resolve) => { release = resolve })
      const started = new Promise<void>((resolve) => { entered = resolve })
      if (stage === 'metadata') {
        const metadata = sharp.prototype.metadata
        t.mock.method(sharp.prototype, 'metadata', async function (this: Sharp) {
          if (waiting < 4) {
            if (++waiting === 4) entered()
            await gate
          }
          return metadata.call(this)
        })
      }
      t.mock.method(fs.promises, 'open', async (...args: unknown[]) => {
        const handle: FileHandle = await Reflect.apply(original, fs.promises, args)
        handles.push(handle)
        if (stage === 'metadata') return handle
        const method = handle[stage]
        let first = true
        t.mock.method(handle, stage, async (...methodArgs: unknown[]) => {
          if (first && handles.indexOf(handle) < 4) {
            first = false
            if (++waiting === 4) entered()
            await gate
          }
          return Reflect.apply(method, handle, methodArgs)
        })
        return handle
      })
      const abort = new AbortController()
      const active = rels.slice(0, 4).map((rel, i) => mediaAssetStore.readForServeAsync(rel, i === 0 ? abort.signal : undefined))
      let cancelledSettled = false
      const rejected = assert.rejects(active[0], { name: 'AbortError' }).then(() => { cancelledSettled = true })
      let next: ReturnType<typeof mediaAssetStore.readForServeAsync> | undefined
      try {
        await started
        abort.abort()
        next = mediaAssetStore.readForServeAsync(rels[4])
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(cancelledSettled, false)
        assert.equal(handles.length, 4)
        assert.equal(stats.mock.calls.filter(call => call.arguments[0] === mediaAssetStore.resolve(rels[4])).length, 0)
        release()
        await rejected
        await Promise.all(active.slice(1))
        assert.deepEqual((await next).body, JPEG_1X1)
        assert.ok(handles.every(handle => handle.fd === -1))
      } finally {
        release()
        await Promise.allSettled([...active, rejected, ...(next ? [next] : [])])
      }
    })
  }

  it('rejects oversized plain and encrypted files before opening or decrypting them', async (t) => {
    setup()
    mediaAssetStore.importAvatarDisplay('Small', 1, JPEG_1X1)
    const open = t.mock.method(fs.promises, 'open')
    const decrypt = t.mock.method(crypto.webcrypto.subtle, 'decrypt')
    for (const ext of ['jpg', 'enc']) {
      const rel = `avatars/oversized.${ext}`
      fs.writeFileSync(mediaAssetStore.resolve(rel), '')
      fs.truncateSync(mediaAssetStore.resolve(rel), MAX_ASSET_READ_BYTES + 1)
      await assert.rejects(mediaAssetStore.readForServeAsync(rel), AssetReadTooLargeError)
    }
    assert.equal(open.mock.callCount(), 0)
    assert.equal(decrypt.mock.callCount(), 0)
  })
  it('does not merge a post-invalidation request into the old pending read', { timeout: 5000 }, async (t) => {
    setup()
    const rel = mediaAssetStore.importAvatarDisplay('NewGeneration', 1, JPEG_1X1)
    let release!: () => void
    let firstStarted!: () => void
    let secondStarted!: () => void
    const first = new Promise<void>((resolve) => { firstStarted = resolve })
    const second = new Promise<void>((resolve) => { secondStarted = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const original = fs.promises.open
    let calls = 0
    t.mock.method(fs.promises, 'open', async (...args: unknown[]) => {
      const number = ++calls
      const raw = await Reflect.apply(original, fs.promises, args)
      if (number === 1) { firstStarted(); await gate }
      else secondStarted()
      return raw
    })
    const old = mediaAssetStore.readForServeAsync(rel)
    try {
      await first
      invalidateAssetCache(rel)
      const current = mediaAssetStore.readForServeAsync(rel)
      await second
      assert.deepEqual((await current).body, JPEG_1X1)
      release()
      await old
      await mediaAssetStore.readForServeAsync(rel)
      assert.equal(calls, 2)
    } finally {
      release()
      await old
    }
  })

  it('shares a cold encrypted read and decryption across concurrent requests without sharing cancellation', async (t) => {
    const testRoot = setup()
    const rel = 'avatars/shared.enc'
    fs.mkdirSync(path.join(testRoot, 'media_assets', 'avatars'), { recursive: true })
    fs.writeFileSync(mediaAssetStore.resolve(rel), encryptPlain(JPEG_1X1, '.jpg'))
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const original = fs.promises.open
    const reads = t.mock.method(fs.promises, 'open', async (...args: unknown[]) => {
      entered()
      await gate
      return Reflect.apply(original, fs.promises, args)
    })
    const decrypts = t.mock.method(crypto.webcrypto.subtle, 'decrypt')
    const abort = new AbortController()
    const cancelled = mediaAssetStore.readForServeAsync(rel, abort.signal)
    const rejected = assert.rejects(cancelled, { name: 'AbortError' })
    const consumers = Array.from({ length: 11 }, () => mediaAssetStore.readForServeAsync(rel))
    await started
    abort.abort()
    await rejected
    release()
    const images = await Promise.all(consumers)
    assert.ok(images.every((image) => image.body.equals(JPEG_1X1)))
    images[0].body.fill(0)
    assert.deepEqual(images[1].body, JPEG_1X1)
    assert.equal(reads.mock.callCount(), 1)
    assert.equal(decrypts.mock.callCount(), 1)
  })

  it('does not return cached bytes when cancelled while the hot-path stat is pending', async (t) => {
    setup()
    const rel = mediaAssetStore.importAvatarDisplay('HotCancel', 1, JPEG_1X1)
    await mediaAssetStore.readForServeAsync(rel)
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const original = fs.promises.stat
    t.mock.method(fs.promises, 'stat', async (...args: unknown[]) => {
      const stat = await Reflect.apply(original, fs.promises, args)
      entered()
      await gate
      return stat
    })
    const reads = t.mock.method(fs.promises, 'open')
    const abort = new AbortController()
    const pending = mediaAssetStore.readForServeAsync(rel, abort.signal)
    const rejected = assert.rejects(pending, { name: 'AbortError' })
    await started
    abort.abort()
    release()
    await rejected
    assert.equal(reads.mock.callCount(), 0)
    assert.deepEqual((await mediaAssetStore.readForServeAsync(rel)).body, JPEG_1X1)
    assert.equal(reads.mock.callCount(), 0)
  })

  it('does not reuse the same relative cache key after the asset root changes', async () => {
    const firstRoot = setup()
    const rel = mediaAssetStore.importAvatarDisplay('Root', 1, JPEG_1X1)
    await mediaAssetStore.readForServeAsync(rel)
    const secondRoot = path.join(firstRoot, 'other-user')
    const secondFile = path.join(secondRoot, 'media_assets', rel)
    fs.mkdirSync(path.dirname(secondFile), { recursive: true })
    const updated = Buffer.concat([JPEG_1X1, Buffer.from('different root')])
    fs.writeFileSync(secondFile, updated)
    process.env.JAVDEX_TEST_USER_DATA = secondRoot
    try { assert.deepEqual((await mediaAssetStore.readForServeAsync(rel)).body, updated) }
    finally { process.env.JAVDEX_TEST_USER_DATA = firstRoot }
  })

  it('rejects a changed file during reading without caching its old bytes', async (t) => {
    setup()
    const rel = mediaAssetStore.importAvatarDisplay('DuringRead', 1, JPEG_1X1)
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const original = fs.promises.open
    const reads = t.mock.method(fs.promises, 'open', async (...args: unknown[]) => {
      const raw = await Reflect.apply(original, fs.promises, args)
      entered()
      await gate
      return raw
    })
    const pending = mediaAssetStore.readForServeAsync(rel)
    const rejected = assert.rejects(pending, /changed while reading/)
    await started
    const changed = Buffer.concat([JPEG_1X1, Buffer.from('updated image')])
    fs.writeFileSync(mediaAssetStore.resolve(rel), changed)
    release()
    await rejected
    assert.deepEqual((await mediaAssetStore.readForServeAsync(rel)).body, changed)
    await mediaAssetStore.readForServeAsync(rel)
    assert.equal(reads.mock.callCount(), 2)
  })

  it('serves hot plaintext and encrypted images without rereading or decrypting their bytes', async (t) => {
    const testRoot = setup()
    const plain = mediaAssetStore.importAvatarDisplay('Cached', 1, JPEG_1X1)
    const enc = 'avatars/cached.enc'
    fs.writeFileSync(path.join(testRoot, 'media_assets', enc), encryptPlain(JPEG_1X1, '.jpg'))
    const reads = t.mock.method(fs.promises, 'open')
    const decrypts = t.mock.method(crypto.webcrypto.subtle, 'decrypt')
    for (const rel of [plain, enc]) {
      const first = await mediaAssetStore.readForServeAsync(rel)
      first.body.fill(0)
      assert.deepEqual((await mediaAssetStore.readForServeAsync(rel)).body, JPEG_1X1)
    }
    assert.equal(reads.mock.callCount(), 2)
    assert.equal(decrypts.mock.callCount(), 1)
    invalidateAssetCache(enc)
    await mediaAssetStore.readForServeAsync(enc)
    assert.equal(reads.mock.callCount(), 3)
    assert.equal(decrypts.mock.callCount(), 2)
  })

  it('reloads replaced files even with restored mtime and rejects deleted files before using cache', async (t) => {
    setup()
    const rel = mediaAssetStore.importAvatarDisplay('Replaced', 1, JPEG_1X1)
    const abs = mediaAssetStore.resolve(rel)
    const originalStat = fs.statSync(abs)
    const reads = t.mock.method(fs.promises, 'open')
    await mediaAssetStore.readForServeAsync(rel)
    const updated = Buffer.from(JPEG_1X1)
    updated[updated.length - 3] ^= 1
    fs.writeFileSync(abs + '.replacement', updated)
    fs.utimesSync(abs + '.replacement', originalStat.atime, originalStat.mtime)
    fs.renameSync(abs + '.replacement', abs)
    assert.deepEqual((await mediaAssetStore.readForServeAsync(rel)).body, updated)
    assert.equal(reads.mock.callCount(), 2)
    fs.unlinkSync(abs)
    await assert.rejects(mediaAssetStore.readForServeAsync(rel), { code: 'ENOENT' })
    fs.writeFileSync(abs, JPEG_1X1)
    assert.deepEqual((await mediaAssetStore.readForServeAsync(rel)).body, JPEG_1X1)
    assert.equal(reads.mock.callCount(), 3)
  })

  it('does not repopulate explicitly invalidated cache from a pending read', async (t) => {
    setup()
    const rel = mediaAssetStore.importAvatarDisplay('Invalidated', 1, JPEG_1X1)
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const original = fs.promises.open
    const reads = t.mock.method(fs.promises, 'open', async (...args: unknown[]) => {
      const raw = await Reflect.apply(original, fs.promises, args)
      entered()
      await gate
      return raw
    })
    const pending = mediaAssetStore.readForServeAsync(rel)
    await started
    invalidateAssetCache(rel)
    release()
    await pending
    await mediaAssetStore.readForServeAsync(rel)
    assert.equal(reads.mock.callCount(), 2)
  })

  it('retains read slots while cancelled encrypted requests wait for native crypto completion', async (t) => {
    const testRoot = setup()
    const rel = 'avatars/crypto-queue.enc'
    fs.mkdirSync(path.join(testRoot, 'media_assets', 'avatars'), { recursive: true })
    fs.writeFileSync(path.join(testRoot, 'media_assets', rel), encryptPlain(JPEG_1X1, '.jpg'))
    const nextRel = 'avatars/crypto-queue-next.enc'
    fs.copyFileSync(path.join(testRoot, 'media_assets', rel), path.join(testRoot, 'media_assets', nextRel))
    const activeRels = Array.from({ length: 4 }, (_, i) => `avatars/crypto-active-${i}.enc`)
    for (const item of activeRels) fs.copyFileSync(mediaAssetStore.resolve(rel), mediaAssetStore.resolve(item))
    const stats = t.mock.method(fs.promises, 'stat')
    let release!: () => void
    let allStarted!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { allStarted = resolve })
    const subtle = crypto.webcrypto.subtle
    const decrypt = subtle.decrypt
    const reads = t.mock.method(fs.promises, 'open')
    let jobs = 0
    t.mock.method(subtle, 'decrypt', async (...args: unknown[]) => {
      if (++jobs === 4) allStarted()
      await gate
      return Reflect.apply(decrypt, subtle, args)
    })
    const abort = new AbortController()
    const requests = activeRels.map((item, i) => mediaAssetStore.readForServeAsync(item, i === 0 ? abort.signal : undefined))
    const rejected = assert.rejects(requests.shift()!, { name: 'AbortError' })
    await started
    abort.abort()
    const next = mediaAssetStore.readForServeAsync(nextRel)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(jobs, 4)
    assert.equal(stats.mock.calls.filter(call => call.arguments[0] === mediaAssetStore.resolve(nextRel)).length, 0)
    assert.equal(reads.mock.callCount(), 4, 'the fifth request must not start reading before a crypto slot is released')
    release()
    await rejected
    await Promise.all(requests)
    assert.deepEqual((await next).body, JPEG_1X1)
    assert.equal(jobs, 5)
    assert.equal(stats.mock.calls.filter(call => call.arguments[0] === mediaAssetStore.resolve(nextRel)).length, 2)
    assert.equal(reads.mock.callCount(), 5)
  })

  it('cancels queued reads before opening files and keeps active slots until reads settle', async (t) => {
    setup()
    const rel = mediaAssetStore.importAvatarDisplay('Queued', 1, JPEG_1X1)
    const nextRel = mediaAssetStore.importAvatarDisplay('Next', 2, JPEG_1X1)
    const activeRels = Array.from({ length: 4 }, (_, i) => mediaAssetStore.importAvatarDisplay(`Active${i}`, i + 3, JPEG_1X1))
    const stats = t.mock.method(fs.promises, 'stat')
    let release!: () => void
    let allStarted!: () => void
    const started = new Promise<void>((resolve) => { allStarted = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const original = fs.promises.open
    let reads = 0
    t.mock.method(fs.promises, 'open', async (...args: unknown[]) => {
      reads++
      if (reads === 4) allStarted()
      await gate
      return Reflect.apply(original, fs.promises, args)
    })
    const activeAbort = new AbortController()
    const active = activeRels.map((item, i) => mediaAssetStore.readForServeAsync(item, i === 0 ? activeAbort.signal : undefined))
    const activeRejected = assert.rejects(active.shift()!, { name: 'AbortError' })
    const queuedAbort = new AbortController()
    const queued = mediaAssetStore.readForServeAsync(rel, queuedAbort.signal)
    const queuedRejected = assert.rejects(queued, { name: 'AbortError' })
    await started
    assert.equal(reads, 4)
    activeAbort.abort()
    queuedAbort.abort()
    await queuedRejected
    const next = mediaAssetStore.readForServeAsync(nextRel)
    await Promise.resolve()
    assert.equal(reads, 4, 'active cancellation must wait for the reader to settle')
    assert.equal(stats.mock.calls.filter(call => call.arguments[0] === mediaAssetStore.resolve(nextRel)).length, 0)
    release()
    await activeRejected
    await Promise.all(active)
    assert.deepEqual((await next).body, JPEG_1X1)
    assert.equal(reads, 5, 'the cancelled queued request never opened a file')
    assert.equal(stats.mock.calls.filter(call => call.arguments[0] === mediaAssetStore.resolve(nextRel)).length, 2)
  })

  it('serves plain and encrypted images asynchronously without synchronous file reads', async (t) => {
    const testRoot = setup()
    const rel = mediaAssetStore.importAvatarDisplay('Async', 1, JPEG_1X1)
    const enc = 'avatars/async.enc'
    fs.writeFileSync(path.join(testRoot, 'media_assets', enc), encryptPlain(JPEG_1X1, '.jpg'))
    resetAssetKeyCacheForTests()
    t.mock.method(fs, 'readFileSync', () => { throw Error('synchronous file read forbidden') })
    t.mock.method(crypto, 'scryptSync', () => { throw Error('synchronous key derivation forbidden') })
    t.mock.method(crypto, 'createDecipheriv', () => { throw Error('synchronous decryption forbidden') })
    const plain = await mediaAssetStore.readForServeAsync(rel)
    const encrypted = await mediaAssetStore.readForServeAsync(enc)
    assert.deepEqual(plain.body, JPEG_1X1)
    assert.deepEqual(encrypted, { body: JPEG_1X1, mime: 'image/jpeg' })
    await assert.rejects(mediaAssetStore.readForServeAsync('../outside.jpg'), /escapes media root/)
    await assert.rejects(mediaAssetStore.readForServeAsync('avatars/missing.jpg'), { code: 'ENOENT' })
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(mediaAssetStore.readForServeAsync(rel, abort.signal), { name: 'AbortError' })
  })

  it('reads plain and encrypted images and reports a stable plaintext fingerprint', () => {
    const testRoot = setup()
    const plainPath = mediaAssetStore.importAvatarDisplay('Plain', 1, JPEG_1X1)
    assert.deepEqual(mediaAssetStore.readBytes(plainPath), JPEG_1X1)
    const plainInspection = mediaAssetStore.inspectImage(plainPath)
    assert.equal(plainInspection.usable, true)
    assert.equal(plainInspection.fingerprint, mediaAssetStore.fingerprint(JPEG_1X1))

    const encryptedPath = 'avatars/encrypted-test.enc'
    const absolutePath = path.join(testRoot, 'media_assets', encryptedPath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, encryptPlain(JPEG_1X1, '.jpg'))
    assert.deepEqual(mediaAssetStore.readBytes(encryptedPath), JPEG_1X1)
    assert.equal(mediaAssetStore.inspectImage(encryptedPath).usable, true)
  })

  it('rejects stored paths that escape the media root', () => {
    setup()
    assert.throws(() => mediaAssetStore.resolve('../outside.jpg'), /escapes media root/)
    assert.throws(() => mediaAssetStore.resolve(path.resolve('outside.jpg')), /escapes media root/)
  })

  it('exposes bootstrap and layout paths under the media root', () => {
    const testRoot = setup()
    mediaAssetStore.ensureReady()
    const root = mediaAssetStore.rootPath()
    assert.equal(root, path.join(testRoot, 'media_assets'))
    assert.equal(mediaAssetStore.subdirPath('covers'), path.join(root, 'covers'))
    assert.equal(fs.existsSync(mediaAssetStore.subdirPath('playlist_covers')), true)
  })

  it('encrypts a stored plain asset and lists it under stable subdirectories', () => {
    setup()
    mediaAssetStore.ensureReady()
    const plainRel = 'covers/MIG-001_abcd1234.jpg'
    fs.writeFileSync(mediaAssetStore.resolve(plainRel), JPEG_1X1)

    assert.deepEqual(mediaAssetStore.listStoredImageAssetRels(), [plainRel])
    const rewrite = mediaAssetStore.encryptStoredAsset(plainRel)
    assert.ok(rewrite)
    assert.equal(rewrite.fromRel, plainRel)
    assert.equal(rewrite.toRel.startsWith('covers/'), true)
    assert.equal(rewrite.toRel.endsWith('.enc'), true)
    assert.equal(isOpaqueEncFilename(path.posix.basename(rewrite.toRel)), true)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(plainRel)), false)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(rewrite.toRel)), true)
    assert.equal(getPathAlias(rewrite.toRel), plainRel)
    assert.deepEqual(mediaAssetStore.listStoredImageAssetRels(), [rewrite.toRel])
  })

  it('decrypts a stored encrypted asset back to its plain relative path', () => {
    setup()
    mediaAssetStore.ensureReady()
    const plainRel = 'covers/MIG-002_abcd1234.jpg'
    fs.writeFileSync(mediaAssetStore.resolve(plainRel), JPEG_1X1)
    const encrypted = mediaAssetStore.encryptStoredAsset(plainRel)
    assert.ok(encrypted)

    const rewrite = mediaAssetStore.decryptStoredAsset(encrypted.toRel)
    assert.ok(rewrite)
    assert.equal(rewrite.fromRel, encrypted.toRel)
    assert.equal(rewrite.toRel, plainRel)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(encrypted.toRel)), false)
    assert.deepEqual(mediaAssetStore.readBytes(plainRel), JPEG_1X1)
    mediaAssetStore.clearPathAliases()
    assert.equal(getPathAlias(encrypted.toRel) ?? null, null)
  })

  it('compensates newly-created resources when the database operation fails', () => {
    setup()
    let createdPath = ''
    assert.throws(
      () =>
        mediaAssetStore.coordinateDatabaseChange(() => {
          createdPath = mediaAssetStore.importAvatarDisplay('测试演员', 7, JPEG_1X1)
          assert.equal(fs.existsSync(mediaAssetStore.resolve(createdPath)), true)
          throw new Error('database failed')
        }),
      /database failed/
    )
    assert.equal(fs.existsSync(mediaAssetStore.resolve(createdPath)), false)
  })

  it('compensates newly imported cover and sample files when a database operation fails', () => {
    const testRoot = setup()
    const sourcePath = path.join(testRoot, 'source.jpg')
    fs.writeFileSync(sourcePath, JPEG_1X1)
    let coverPath = ''
    let samplePath = ''
    assert.throws(() => mediaAssetStore.coordinateDatabaseChange(() => {
      coverPath = mediaAssetStore.importCover('TEST-001', sourcePath)
      samplePath = mediaAssetStore.importSample('TEST-001', sourcePath)
      throw new Error('database failed')
    }), /database failed/)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(coverPath)), false)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(samplePath)), false)
  })

  it('compensates newly imported playlist covers when a database operation fails', () => {
    const testRoot = setup()
    const sourcePath = path.join(testRoot, 'playlist-cover.jpg')
    fs.writeFileSync(sourcePath, JPEG_1X1)
    let coverPath = ''
    assert.throws(() => mediaAssetStore.coordinateDatabaseChange(() => {
      coverPath = mediaAssetStore.importPlaylistCover('Watch Later', sourcePath)
      throw new Error('database failed')
    }), /database failed/)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(coverPath)), false)
  })

  it('compensates async downloads when the database operation fails', async () => {
    setup()
    let createdPath = ''
    await assert.rejects(
      () =>
        mediaAssetStore.coordinateDatabaseChange(async () => {
          createdPath = mediaAssetStore.importAvatarDisplay('测试演员', 9, JPEG_1X1)
          await Promise.resolve()
          throw new Error('async database failed')
        }),
      /async database failed/
    )
    assert.equal(fs.existsSync(mediaAssetStore.resolve(createdPath)), false)
  })

  it('rejects unusable local image imports instead of storing them', () => {
    const testRoot = setup()
    const brokenPath = path.join(testRoot, 'broken.jpg')
    fs.writeFileSync(brokenPath, Buffer.from('<html>not an image</html>'))

    assert.throws(() => mediaAssetStore.importCover('BAD-001', brokenPath), /不是可用图片/)
    assert.throws(() => mediaAssetStore.importSample('BAD-001', brokenPath), /不是可用图片/)
    assert.throws(
      () => mediaAssetStore.importPlaylistCover('Broken List', brokenPath),
      /不是可用图片/
    )
    assert.throws(
      () => mediaAssetStore.importActressGallery('Broken Gallery', brokenPath, 1),
      /不是可用图片/
    )
    assert.throws(
      () => mediaAssetStore.importAvatarDisplay('Broken Avatar', 1, Buffer.from('{not:image}')),
      /不是可用图片/
    )
    assert.throws(
      () => mediaAssetStore.importAvatarSource('Broken Avatar', 1, Buffer.from('')),
      /不是可用图片/
    )

    for (const kind of ['covers', 'samples', 'playlist_covers', 'actress_gallery', 'avatars'] as const) {
      const dir = mediaAssetStore.subdirPath(kind)
      assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0)
    }
  })

  it('rejects unusable avatar downloads instead of storing them', async () => {
    setup()
    const storedPath = await mediaAssetStore.downloadAvatar(
      'Bad Avatar',
      'https://example.test/avatar.html',
      async () => Buffer.from('<html>not an image</html>')
    )
    assert.equal(storedPath, null)
    const avatarDir = mediaAssetStore.subdirPath('avatars')
    assert.equal(fs.existsSync(avatarDir) ? fs.readdirSync(avatarDir).length : 0, 0)
  })

  it('keeps an existing download when replacing the same URL later rolls back', async () => {
    setup()
    const url = 'https://example.test/cover.jpg'
    const originalPath = await mediaAssetStore.downloadCover('SAFE-001', url, async () => JPEG_1X1)
    assert.ok(originalPath)
    let replacementPath: string | null = null

    await assert.rejects(
      () =>
        mediaAssetStore.coordinateDatabaseChange(async () => {
          replacementPath = await mediaAssetStore.downloadCover('SAFE-001', url, async () => JPEG_1X1)
          throw new Error('database failed')
        }),
      /database failed/
    )

    assert.ok(replacementPath)
    assert.notEqual(replacementPath, originalPath)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(originalPath)), true)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(replacementPath)), false)
  })

  it('keeps an existing avatar source when importing the same bytes later rolls back', async () => {
    setup()
    const original = mediaAssetStore.importAvatarSource('Same Source', 7, JPEG_1X1)
    let replacementPath = ''

    assert.throws(
      () =>
        mediaAssetStore.coordinateDatabaseChange(() => {
          replacementPath = mediaAssetStore.importAvatarSource(
            'Same Source',
            7,
            JPEG_1X1
          ).relPath
          throw new Error('database failed')
        }),
      /database failed/
    )

    assert.notEqual(replacementPath, original.relPath)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(original.relPath)), true)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(replacementPath)), false)
  })

  it('deletes obsolete resources only after the database operation succeeds', () => {
    setup()
    const storedPath = mediaAssetStore.importAvatarDisplay('测试演员', 8, JPEG_1X1)
    const absolutePath = mediaAssetStore.resolve(storedPath)
    mediaAssetStore.coordinateDatabaseChange(() => {
      mediaAssetStore.deleteBestEffort(storedPath)
      assert.equal(fs.existsSync(absolutePath), true)
    })
    assert.equal(fs.existsSync(absolutePath), false)
  })

  it('uses distinct paths for avatar display replacements created in the same millisecond', () => {
    setup()
    const originalNow = Date.now
    Date.now = () => 1_700_000_000_000
    try {
      const firstPath = mediaAssetStore.importAvatarDisplay('测试演员', 9, JPEG_1X1)
      const secondPath = mediaAssetStore.importAvatarDisplay('测试演员', 9, JPEG_1X1)

      assert.notEqual(secondPath, firstPath)
    } finally {
      Date.now = originalNow
    }
  })

  it('discards newly created resources marked obsolete in the same coordinated change', () => {
    setup()
    let createdPath = ''
    mediaAssetStore.coordinateDatabaseChange(() => {
      createdPath = mediaAssetStore.importAvatarDisplay('测试演员', 10, JPEG_1X1)
      mediaAssetStore.deleteBestEffort(createdPath)
      assert.equal(fs.existsSync(mediaAssetStore.resolve(createdPath)), true)
    })
    assert.equal(fs.existsSync(mediaAssetStore.resolve(createdPath)), false)
  })

  it('promotes nested created resources so a parent rollback can compensate them', () => {
    setup()
    let nestedPath = ''
    assert.throws(
      () =>
        mediaAssetStore.coordinateDatabaseChange(() => {
          mediaAssetStore.coordinateDatabaseChange(() => {
            nestedPath = mediaAssetStore.importAvatarDisplay('测试演员', 11, JPEG_1X1)
          })
          assert.equal(fs.existsSync(mediaAssetStore.resolve(nestedPath)), true)
          throw new Error('parent failed')
        }),
      /parent failed/
    )
    assert.equal(fs.existsSync(mediaAssetStore.resolve(nestedPath)), false)
  })

  it('defers nested obsolete deletes of pre-existing files until the parent commits', () => {
    setup()
    const oldPath = mediaAssetStore.importAvatarDisplay('测试演员', 20, JPEG_1X1)
    let newPath = ''
    mediaAssetStore.coordinateDatabaseChange(() => {
      mediaAssetStore.coordinateDatabaseChange(() => {
        newPath = mediaAssetStore.importAvatarDisplay('测试演员', 20, JPEG_1X1)
        mediaAssetStore.deleteBestEffort(oldPath)
      })
      assert.equal(fs.existsSync(mediaAssetStore.resolve(oldPath)), true)
      assert.equal(fs.existsSync(mediaAssetStore.resolve(newPath)), true)
    })
    assert.equal(fs.existsSync(mediaAssetStore.resolve(oldPath)), false)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(newPath)), true)
  })

  it('keeps nested obsolete pre-existing files when the parent rolls back', () => {
    setup()
    const oldPath = mediaAssetStore.importAvatarDisplay('测试演员', 21, JPEG_1X1)
    let nestedPath = ''
    assert.throws(
      () =>
        mediaAssetStore.coordinateDatabaseChange(() => {
          mediaAssetStore.coordinateDatabaseChange(() => {
            nestedPath = mediaAssetStore.importAvatarDisplay('测试演员', 21, JPEG_1X1)
            mediaAssetStore.deleteBestEffort(oldPath)
          })
          throw new Error('parent failed')
        }),
      /parent failed/
    )
    assert.equal(fs.existsSync(mediaAssetStore.resolve(oldPath)), true)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(nestedPath)), false)
  })

  it('does not leak nested create-then-obsolete files when the parent rolls back', () => {
    setup()
    let discardedPath = ''
    assert.throws(
      () =>
        mediaAssetStore.coordinateDatabaseChange(() => {
          mediaAssetStore.coordinateDatabaseChange(() => {
            discardedPath = mediaAssetStore.importAvatarDisplay('测试演员', 22, JPEG_1X1)
            mediaAssetStore.deleteBestEffort(discardedPath)
          })
          throw new Error('parent failed')
        }),
      /parent failed/
    )
    assert.equal(fs.existsSync(mediaAssetStore.resolve(discardedPath)), false)
  })

  it('runInCoordinatedChange joins an active parent instead of nesting', () => {
    setup()
    let joinedPath = ''
    assert.throws(
      () =>
        mediaAssetStore.coordinateDatabaseChange(() => {
          mediaAssetStore.runInCoordinatedChange(() => {
            joinedPath = mediaAssetStore.importAvatarDisplay('测试演员', 23, JPEG_1X1)
          })
          throw new Error('parent failed')
        }),
      /parent failed/
    )
    assert.equal(fs.existsSync(mediaAssetStore.resolve(joinedPath)), false)
  })

  it('keeps isolated coordinated creates when an outer parent later rolls back', () => {
    setup()
    let isolatedPath = ''
    assert.throws(
      () =>
        mediaAssetStore.coordinateDatabaseChange(() => {
          mediaAssetStore.coordinateDatabaseChangeIsolated(() => {
            isolatedPath = mediaAssetStore.importAvatarDisplay('Isolated', 40, JPEG_1X1)
          })
          throw new Error('parent failed')
        }),
      /parent failed/
    )
    assert.equal(fs.existsSync(mediaAssetStore.resolve(isolatedPath)), true)
  })

  it('keeps independent root work when an awaited outer coordinated change fails', async () => {
    setup()
    let outerPath = ''
    let siblingPath = ''
    let releaseOuter!: () => void
    const outerGate = new Promise<void>((resolve) => {
      releaseOuter = resolve
    })

    const outerPromise = mediaAssetStore.coordinateDatabaseChange(async () => {
      outerPath = mediaAssetStore.importAvatarDisplay('Outer', 12, JPEG_1X1)
      await outerGate
      throw new Error('outer failed')
    })

    await Promise.resolve()
    mediaAssetStore.coordinateDatabaseChange(() => {
      siblingPath = mediaAssetStore.importAvatarDisplay('Sibling', 13, JPEG_1X1)
    })
    releaseOuter()
    await assert.rejects(() => outerPromise, /outer failed/)

    assert.equal(fs.existsSync(mediaAssetStore.resolve(outerPath)), false)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(siblingPath)), true)
  })

  it('keeps relocation exclusive with coordinated and direct media mutations', async () => {
    setup()
    const store = new MediaAssetStore()
    let releaseChange!: () => void
    const changeGate = new Promise<void>((resolve) => {
      releaseChange = resolve
    })
    const activeChange = store.coordinateDatabaseChange(async () => {
      await changeGate
    })
    await Promise.resolve()

    await assert.rejects(
      () => store.runExclusiveRelocation(async () => undefined),
      /已有媒体资源任务/
    )
    releaseChange()
    await activeChange

    let releaseRelocation!: () => void
    let relocationStarted!: () => void
    const relocationGate = new Promise<void>((resolve) => {
      releaseRelocation = resolve
    })
    const started = new Promise<void>((resolve) => {
      relocationStarted = resolve
    })
    const relocation = store.runExclusiveRelocation(async () => {
      relocationStarted()
      assert.doesNotThrow(() => store.importAvatarDisplay('Owner', 98, JPEG_1X1))
      await relocationGate
    })
    await started
    assert.throws(() => store.importAvatarDisplay('Blocked', 99, JPEG_1X1), /维护正在进行/)
    releaseRelocation()
    await relocation
  })

  it('keeps relocation exclusive with a stable read lease', async () => {
    setup()
    const store = new MediaAssetStore()
    const lease = store.acquireStableReadLease()
    await assert.rejects(
      () => store.runExclusiveRelocation(async () => undefined),
      /已有媒体资源任务/
    )
    lease.release()
    lease.release()
    await assert.doesNotReject(() => store.runExclusiveRelocation(async () => undefined))

    let releaseRelocation!: () => void
    let relocationStarted!: () => void
    const gate = new Promise<void>((resolve) => { releaseRelocation = resolve })
    const started = new Promise<void>((resolve) => { relocationStarted = resolve })
    const relocation = store.runExclusiveRelocation(async () => {
      relocationStarted()
      await gate
    })
    await started
    assert.throws(() => store.acquireStableReadLease(), /维护正在进行/)
    releaseRelocation()
    await relocation
  })

  it('keeps caller registrations off an un-awaited nested async coordinated change', async () => {
    setup()
    let nestedPath = ''
    let callerPath = ''
    let releaseNested!: () => void
    const nestedGate = new Promise<void>((resolve) => {
      releaseNested = resolve
    })

    await mediaAssetStore.coordinateDatabaseChange(async () => {
      const nestedPromise = mediaAssetStore.coordinateDatabaseChange(async () => {
        await nestedGate
        nestedPath = mediaAssetStore.importAvatarDisplay('Nested', 30, JPEG_1X1)
        throw new Error('nested failed')
      })
      callerPath = mediaAssetStore.importAvatarDisplay('Caller', 31, JPEG_1X1)
      releaseNested()
      await assert.rejects(() => nestedPromise, /nested failed/)
      assert.equal(fs.existsSync(mediaAssetStore.resolve(callerPath)), true)
      assert.equal(fs.existsSync(mediaAssetStore.resolve(nestedPath)), false)
    })

    assert.equal(fs.existsSync(mediaAssetStore.resolve(callerPath)), true)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(nestedPath)), false)
  })

  it('does not turn a post-commit cleanup failure into a database failure', () => {
    const testRoot = setup()
    const sourcePath = path.join(testRoot, 'source.jpg')
    fs.writeFileSync(sourcePath, JPEG_1X1)
    class FailingCleanupStore extends MediaAssetStore {
      override delete(): void {
        throw new Error('file is locked')
      }
    }
    const store = new FailingCleanupStore()
    const storedPath = store.importCover('TEST-002', sourcePath)
    assert.doesNotThrow(() => store.coordinateDatabaseChange(() => {
      store.deleteBestEffort(storedPath)
    }))
    assert.equal(fs.existsSync(store.resolve(storedPath)), true)
  })
})
