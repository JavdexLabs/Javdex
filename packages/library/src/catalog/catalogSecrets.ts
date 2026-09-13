import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { SECRET_RANDOM_BYTES } from '@shared/protocol/limits'

const DIGEST_BYTES = 32

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function generateSecret(): string {
  return randomBytes(SECRET_RANDOM_BYTES).toString('base64url')
}

export function digestEquals(leftHex: string, rightHex: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(leftHex) || !/^[a-f0-9]{64}$/.test(rightHex)) return false
  return timingSafeEqual(Buffer.from(leftHex, 'hex'), Buffer.from(rightHex, 'hex'))
}

export function digestToken(token: string): string {
  return sha256Hex(token)
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

export function digestRequest(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

export function assertDigestLength(digest: string, label: string): void {
  if (digest.length !== DIGEST_BYTES * 2 || !/^[a-f0-9]+$/.test(digest)) {
    throw new Error(`${label} must be a SHA-256 hex digest`)
  }
}
