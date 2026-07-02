import crypto from 'node:crypto'

const READABLE_SEED_MAX = 40
const URL_HASH_LEN = 8
const OPAQUE_HASH_LEN = 16

function md5Slice(input: string, len: number): string {
  return crypto.createHash('md5').update(input).digest('hex').slice(0, len)
}

function sha256Slice(input: string, len: number): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, len)
}

export function sanitizeAssetSeed(seed: string): string {
  return seed.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, READABLE_SEED_MAX)
}

/** Plaintext filename base, e.g. IPX-535_ab12cd34 */
export function buildReadableAssetBase(seed: string, urlKey: string): string {
  const safeSeed = sanitizeAssetSeed(seed)
  return `${safeSeed}_${md5Slice(urlKey, URL_HASH_LEN)}`
}

/** Opaque filename base when encryption hides identifiers in paths. */
export function buildOpaqueAssetBase(seed: string, urlKey: string): string {
  return sha256Slice(`${seed}\0${urlKey}`, OPAQUE_HASH_LEN)
}

/** Derive opaque base from an existing plaintext relative path (migration). */
export function buildOpaqueAssetBaseFromPlainRel(plainRel: string): string {
  return sha256Slice(plainRel, OPAQUE_HASH_LEN)
}

export function isOpaqueEncFilename(filename: string): boolean {
  return new RegExp(`^[a-f0-9]{${OPAQUE_HASH_LEN}}\\.enc$`, 'i').test(filename)
}
