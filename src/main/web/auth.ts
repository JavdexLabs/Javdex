import {
  createHash,
  randomBytes,
  scrypt as derive,
  timingSafeEqual
} from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(derive)
const IDLE_MS = 24 * 60 * 60_000
const LIFETIME_MS = 7 * IDLE_MS
const digest = (text: string): string =>
  createHash('sha256').update(text).digest('hex')

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 128)
    throw new Error('访问密码需为 12–128 个字符')
  const salt = randomBytes(16).toString('hex')
  const key = (await scrypt(password, salt, 64)) as Buffer
  return `${salt}:${key.toString('hex')}`
}
export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const [salt, expected] = stored.split(':')
  if (!/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(expected ?? ''))
    return false
  const key = (await scrypt(password, salt, 64)) as Buffer
  return timingSafeEqual(key, Buffer.from(expected, 'hex'))
}

/** Opaque cookies; only token digests are retained. Restart/reconfiguration revokes all sessions. */
export class WebSessions {
  private sessions = new Map<string, { created: number; touched: number }>()
  constructor(private readonly now = Date.now) {}
  private prune(): void {
    const now = this.now()
    for (const [key, entry] of this.sessions) {
      if (now - entry.touched >= IDLE_MS || now - entry.created >= LIFETIME_MS)
        this.sessions.delete(key)
    }
  }
  create(): string {
    this.prune()
    if (this.sessions.size >= 100)
      this.sessions.delete(this.sessions.keys().next().value!)
    const token = randomBytes(32).toString('base64url')
    this.sessions.set(digest(token), {
      created: this.now(),
      touched: this.now()
    })
    return token
  }
  check(token: string): boolean {
    this.prune()
    const entry = this.sessions.get(digest(token))
    if (!entry) return false
    entry.touched = this.now()
    return true
  }
  revoke(token: string): void {
    this.sessions.delete(digest(token))
  }
  clear(): void {
    this.sessions.clear()
  }
  count(): number {
    this.prune()
    return this.sessions.size
  }
}

/** Bounded per-peer and aggregate budgets, including successful logins. */
export class LoginLimiter {
  private attempts = new Map<string, { count: number; until: number }>()
  private active = 0
  constructor(private readonly now = Date.now) {}
  enter(peer: string): (() => void) | null {
    const now = this.now()
    for (const [key, value] of this.attempts)
      if (value.until <= now) this.attempts.delete(key)
    if (this.active >= 2 || this.attempts.size > 1000) return null
    for (const [key, max] of [
      [peer, 8],
      ['*', 60]
    ] as const) {
      if ((this.attempts.get(key)?.count ?? 0) >= max) return null
    }
    for (const key of [peer, '*']) {
      const value = this.attempts.get(key) ?? {
        count: 0,
        until: now + 15 * 60_000
      }
      value.count++
      this.attempts.set(key, value)
    }
    this.active++
    return () => {
      this.active--
    }
  }
}
