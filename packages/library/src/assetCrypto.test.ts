import { afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { decryptBlob, decryptBlobAsync, deriveAssetKey, encryptPlain, resetAssetKeyCacheForTests } from './assetCrypto'

afterEach(() => resetAssetKeyCacheForTests())

for (const phase of ['scrypt', 'importKey'] as const) {
  it(`retries after the first ${phase} failure`, async (t) => {
    const blob = encryptPlain(Buffer.from('image'), '.jpg')
    resetAssetKeyCacheForTests()
    let calls = 0
    if (phase === 'scrypt') {
      const original = crypto.scrypt
      t.mock.method(crypto, 'scrypt', (...args: unknown[]) => {
        if (++calls !== 1) return Reflect.apply(original, crypto, args)
        const callback = args.at(-1) as (error: Error, key: Buffer) => void
        setImmediate(() => callback(Error('KDF failed'), Buffer.alloc(0)))
      })
    } else {
      const subtle = crypto.webcrypto.subtle
      const original = subtle.importKey
      t.mock.method(subtle, 'importKey', (...args: unknown[]) => {
        if (++calls === 1) return Promise.reject(Error('import failed'))
        return Reflect.apply(original, subtle, args)
      })
    }
    await assert.rejects(decryptBlobAsync(blob), /failed/)
    assert.equal((await decryptBlobAsync(blob)).data.toString(), 'image')
    assert.equal(calls, 2)
  })
}

for (const fails of [false, true]) {
  it(`keeps the new cache when a pre-reset KDF later ${fails ? 'fails' : 'succeeds'}`, async (t) => {
    const previous = process.env.JAVDEX_TEST_USER_DATA
    try {
      process.env.JAVDEX_TEST_USER_DATA = path.join(os.tmpdir(), 'javdex-crypto-key-a')
      resetAssetKeyCacheForTests()
      const blobA = encryptPlain(Buffer.from('a'), '.jpg')
      const keyA = deriveAssetKey()
      process.env.JAVDEX_TEST_USER_DATA = path.join(os.tmpdir(), 'javdex-crypto-key-b')
      resetAssetKeyCacheForTests()
      const blobB = encryptPlain(Buffer.from('b'), '.jpg')
      const keyB = deriveAssetKey()
      resetAssetKeyCacheForTests()
      const callbacks: Array<(error: Error | null, key: Buffer) => void> = []
      const imports = t.mock.method(crypto.webcrypto.subtle, 'importKey')
      t.mock.method(crypto, 'scrypt', (...args: unknown[]) => {
        callbacks.push(args.at(-1) as (error: Error | null, key: Buffer) => void)
      })
      process.env.JAVDEX_TEST_USER_DATA = path.join(os.tmpdir(), 'javdex-crypto-key-a')
      const old = decryptBlobAsync(blobA)
      const rejected = fails ? assert.rejects(old, /old failed/) : null
      resetAssetKeyCacheForTests()
      process.env.JAVDEX_TEST_USER_DATA = path.join(os.tmpdir(), 'javdex-crypto-key-b')
      const current = decryptBlobAsync(blobB)
      callbacks[1](null, keyB)
      assert.equal((await current).data.toString(), 'b')
      callbacks[0](fails ? Error('old failed') : null, keyA)
      if (rejected) await rejected
      else assert.equal((await old).data.toString(), 'a')
      const importedBeforeReuse = imports.mock.callCount()
      assert.equal((await decryptBlobAsync(blobB)).data.toString(), 'b')
      assert.equal(imports.mock.callCount(), importedBeforeReuse, 'old completion must not evict the new CryptoKey')
      assert.deepEqual(deriveAssetKey(), keyB)
      assert.equal(callbacks.length, 2)
    } finally {
      if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
      else process.env.JAVDEX_TEST_USER_DATA = previous
    }
  })
}

it('waits for cold key derivation on cancellation and never starts decryption', async (t) => {
  const blob = encryptPlain(Buffer.from('image'), '.jpg')
  const key = deriveAssetKey()
  resetAssetKeyCacheForTests()
  let finish!: (error: Error | null, key: Buffer) => void
  t.mock.method(crypto, 'scrypt', (...args: unknown[]) => { finish = args.at(-1) as typeof finish })
  const decrypt = t.mock.method(crypto.webcrypto.subtle, 'decrypt', () => { throw Error('must not decrypt') })
  const abort = new AbortController()
  let settled = false
  const operation = decryptBlobAsync(blob, abort.signal).finally(() => { settled = true })
  const rejected = assert.rejects(operation, { name: 'AbortError' })
  abort.abort()
  await Promise.resolve()
  assert.equal(settled, false)
  finish(null, key)
  await rejected
  assert.equal(decrypt.mock.callCount(), 0)
})

it('reads the existing AVPK format through synchronous and asynchronous crypto', async () => {
  for (const size of [0, 1, 4096, 1024 * 1024]) {
    const plain = Buffer.alloc(size, 37)
    for (const ext of ['.jpg', '.png', '.webp', '.gif', '.avif']) {
      const blob = encryptPlain(plain, ext)
      assert.deepEqual(await decryptBlobAsync(blob), decryptBlob(blob))
      assert.deepEqual(await decryptBlobAsync(blob), { data: plain, ext })
    }
  }
})

it('coalesces cold key derivation and never uses synchronous crypto in the async reader', async (t) => {
  const blob = encryptPlain(Buffer.from('image'), '.jpg')
  resetAssetKeyCacheForTests()
  const scrypt = crypto.scrypt
  const calls = t.mock.method(crypto, 'scrypt', (...args: unknown[]) => Reflect.apply(scrypt, crypto, args))
  t.mock.method(crypto, 'scryptSync', () => { throw Error('sync KDF forbidden') })
  t.mock.method(crypto, 'createDecipheriv', () => { throw Error('sync decryption forbidden') })
  const images = await Promise.all(Array.from({ length: 12 }, () => decryptBlobAsync(blob)))
  assert.ok(images.every((image) => image.data.toString() === 'image'))
  assert.equal(calls.mock.callCount(), 1)
  await decryptBlobAsync(blob)
  assert.equal(calls.mock.callCount(), 1)
})

it('rejects invalid or tampered encrypted bodies without returning plaintext', async () => {
  const blob = encryptPlain(Buffer.from('secret'), '.jpg')
  const altered = Buffer.from(blob)
  altered[altered.length - 1] ^= 1
  for (const invalid of [Buffer.from('not encrypted'), blob.subarray(0, 20), altered]) {
    assert.throws(() => decryptBlob(invalid))
    await assert.rejects(decryptBlobAsync(invalid))
  }
})

it('waits for an active native job before discarding its cancelled result', async (t) => {
  const blob = encryptPlain(Buffer.from('image'), '.jpg')
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { started = resolve })
  const subtle = crypto.webcrypto.subtle
  const decrypt = subtle.decrypt
  t.mock.method(subtle, 'decrypt', async (...args: unknown[]) => {
    started()
    await gate
    return Reflect.apply(decrypt, subtle, args)
  })
  const abort = new AbortController()
  let settled = false
  const operation = decryptBlobAsync(blob, abort.signal).finally(() => { settled = true })
  const rejected = assert.rejects(operation, { name: 'AbortError' })
  await entered
  abort.abort()
  await Promise.resolve()
  assert.equal(settled, false)
  release()
  await rejected
  await assert.rejects(decryptBlobAsync(blob, abort.signal), { name: 'AbortError' })
})
