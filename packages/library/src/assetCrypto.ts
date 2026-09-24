import crypto from 'node:crypto'
import os from 'node:os'
import { resolveLibraryUserDataPath } from '@library/runtime/host'

const MAGIC = Buffer.from('AVPK\x01')
const NONCE_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

let cachedKey: Buffer | null = null
let pendingKey: Promise<Buffer> | null = null
let decryptKey: Promise<crypto.webcrypto.CryptoKey> | null = null
let keyGeneration = 0

function resolveUserDataPath(): string {
  return resolveLibraryUserDataPath()
}

function buildAssetKeyMaterial(userDataPath: string): string {
  return [os.hostname(), os.userInfo().username, userDataPath, 'javdex-asset-v1'].join('\0')
}

/** Derive a machine-local AES key (bound to this install). Cached after first use. */
export function deriveAssetKey(): Buffer {
  if (cachedKey) return cachedKey
  cachedKey = crypto.scryptSync(
    buildAssetKeyMaterial(resolveUserDataPath()),
    'javdex-asset-salt',
    KEY_LEN
  )
  return cachedKey
}

export function resetAssetKeyCacheForTests(): void {
  cachedKey = null
  pendingKey = null
  decryptKey = null
  keyGeneration++
}

function deriveAssetKeyAsync(): Promise<Buffer> {
  if (cachedKey) return Promise.resolve(cachedKey)
  if (pendingKey) return pendingKey
  const generation = keyGeneration
  const task = new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(buildAssetKeyMaterial(resolveUserDataPath()), 'javdex-asset-salt', KEY_LEN, (error, key) => {
      if (error) { reject(error); return }
      if (generation === keyGeneration) cachedKey = key
      resolve(key)
    })
  }).finally(() => {
    if (pendingKey === task) pendingKey = null
  })
  pendingKey = task
  return task
}

function getDecryptKey(): Promise<crypto.webcrypto.CryptoKey> {
  if (decryptKey) return decryptKey
  const task = deriveAssetKeyAsync().then(key => crypto.webcrypto.subtle.importKey(
    'raw', new Uint8Array(key), { name: 'AES-GCM' }, false, ['decrypt']
  ))
  decryptKey = task
  void task.catch(() => { if (decryptKey === task) decryptKey = null })
  return task
}

export function isEncryptedBlob(buf: Buffer): boolean {
  return buf.length >= MAGIC.length + 1 + NONCE_LEN + TAG_LEN && buf.subarray(0, MAGIC.length).equals(MAGIC)
}

/** Encrypt image bytes; stores original extension in the blob header. */
export function encryptPlain(plain: Buffer, ext: string): Buffer {
  const extBuf = Buffer.from(ext, 'utf8')
  if (extBuf.length === 0 || extBuf.length > 32) throw new Error('无效的图片扩展名')

  const key = deriveAssetKey()
  const nonce = crypto.randomBytes(NONCE_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()

  return Buffer.concat([MAGIC, Buffer.from([extBuf.length]), extBuf, nonce, encrypted, tag])
}

/** Decrypt an AVPK blob back to raw image bytes + original extension. */
export function decryptBlob(blob: Buffer): { data: Buffer; ext: string } {
  const { ext, nonce, ciphertextAndTag } = parseEncryptedBlob(blob)
  const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - TAG_LEN)
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - TAG_LEN)
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveAssetKey(), nonce)
  decipher.setAuthTag(tag)
  const data = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return { data, ext }
}

/** Native asynchronous crypto jobs; callers keep their queue slot until completion, even on abort. */
export async function decryptBlobAsync(blob: Buffer, signal?: AbortSignal): Promise<{ data: Buffer; ext: string }> {
  signal?.throwIfAborted()
  const { ext, nonce, ciphertextAndTag } = parseEncryptedBlob(blob)
  const key = await getDecryptKey()
  signal?.throwIfAborted()
  const plain = await crypto.webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(nonce), tagLength: TAG_LEN * 8 },
    key,
    new Uint8Array(ciphertextAndTag.buffer, ciphertextAndTag.byteOffset, ciphertextAndTag.byteLength)
  )
  signal?.throwIfAborted()
  return { data: Buffer.from(plain), ext }
}

function parseEncryptedBlob(blob: Buffer): { ext: string; nonce: Buffer; ciphertextAndTag: Buffer } {
  if (!isEncryptedBlob(blob)) throw new Error('不是有效的加密图片文件')

  let off = MAGIC.length
  const extLen = blob[off]
  off += 1
  const ext = blob.subarray(off, off + extLen).toString('utf8')
  off += extLen
  const nonce = blob.subarray(off, off + NONCE_LEN)
  off += NONCE_LEN
  return { ext, nonce, ciphertextAndTag: blob.subarray(off) }
}

export function mimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.avif':
      return 'image/avif'
    default:
      return 'application/octet-stream'
  }
}
