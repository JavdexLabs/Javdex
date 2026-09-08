import {
  createHash,
  randomBytes,
  scrypt as derive,
  timingSafeEqual
} from 'node:crypto'
import fs from 'node:fs'
import { randomInt } from 'node:crypto'
import type { WebDevice } from '../../shared/webTypes'
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

interface SessionEntry extends WebDevice {
  digest: string
}
/** Persistent records contain hashes only; unremembered sessions never reach disk. */
export class WebSessions {
  private sessions = new Map<string, SessionEntry>()
  constructor(
    private readonly now = Date.now,
    private readonly file?: string
  ) {
    if (file && fs.existsSync(file)) {
      const rows: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(rows)) throw new Error('设备记录无效')
      for (const row of rows) {
        if (
          !row ||
          typeof row.digest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(row.digest) ||
          typeof row.id !== 'string' ||
          typeof row.name !== 'string' ||
          row.name.length > 80 ||
          row.remember !== true ||
          !Number.isFinite(row.created) ||
          !Number.isFinite(row.touched)
        )
          throw new Error('设备记录无效')
        this.sessions.set(row.digest, row)
      }
      this.prune()
    }
  }
  private save(): void {
    if (!this.file) return
    fs.writeFileSync(
      `${this.file}.tmp`,
      JSON.stringify([...this.sessions.values()].filter((x) => x.remember)),
      { mode: 0o600 }
    )
    fs.renameSync(`${this.file}.tmp`, this.file)
  }
  private prune(): void {
    for (const [key, row] of this.sessions) {
      if (
        this.now() - row.touched >= IDLE_MS ||
        this.now() - row.created >= LIFETIME_MS
      )
        this.sessions.delete(key)
    }
  }
  create(remember = false, name = '浏览器'): string {
    this.prune()
    if (this.sessions.size >= 100)
      throw new Error('设备数量已达上限，请先撤销旧设备')
    const token = randomBytes(32).toString('base64url')
    const key = digest(token)
    this.sessions.set(key, {
      digest: key,
      id: randomBytes(16).toString('hex'),
      name: name.slice(0, 80),
      remember,
      created: this.now(),
      touched: this.now()
    })
    try {
      this.save()
    } catch (error) {
      this.sessions.delete(key)
      throw error
    }
    return token
  }
  check(token: string): boolean {
    this.prune()
    const row = this.sessions.get(digest(token))
    if (!row) return false
    // Persist activity at minute granularity, without extending absolute lifetime.
    if (this.now() - row.touched >= 60_000) {
      row.touched = this.now()
      this.save()
    }
    return true
  }
  revoke(token: string): void {
    this.sessions.delete(digest(token))
    this.save()
  }
  remove(id: string): void {
    for (const [key, row] of this.sessions)
      if (row.id === id) this.sessions.delete(key)
    this.save()
  }
  clear(): void {
    this.sessions.clear()
    this.save()
  }
  suspend(): void {
    for (const [key, row] of this.sessions)
      if (!row.remember) this.sessions.delete(key)
    this.save()
  }
  list(): WebDevice[] {
    this.prune()
    return [...this.sessions.values()].map(
      ({ id, name, remember, created, touched }) => ({
        id,
        name,
        remember,
        created,
        touched
      })
    )
  }
  count(): number {
    return this.list().length
  }
}

interface PairRequest {
  code: string
  secret: string
  expires: number
  approved: boolean
  remember: boolean
  name: string
  nextPoll: number
}
export class WebPairing {
  private requests = new Map<string, PairRequest>()
  private until = 0
  constructor(private readonly now = Date.now) {}
  open(): void {
    this.until = this.now() + 5 * 60_000
  }
  get enabledUntil(): number {
    return this.until > this.now() ? this.until : 0
  }
  clear(): void {
    this.requests.clear()
    this.until = 0
  }
  private prune(): void {
    for (const [key, row] of this.requests)
      if (row.expires <= this.now()) this.requests.delete(key)
  }
  create(
    remember: boolean,
    name: string
  ): { code: string; secret: string; expires: number } {
    this.prune()
    if (!this.enabledUntil) throw new Error('请先在桌面端开启设备配对')
    if (this.requests.size >= 20) throw new Error('配对请求过多，请稍后重试')
    let code: string
    do {
      code = String(randomInt(1_000_000)).padStart(6, '0')
    } while ([...this.requests.values()].some((x) => x.code === code))
    const secret = randomBytes(32).toString('base64url')
    const expires = this.now() + 5 * 60_000
    this.requests.set(digest(secret), {
      code,
      secret: digest(secret),
      expires,
      approved: false,
      remember,
      name,
      nextPoll: 0
    })
    return { code, secret, expires }
  }
  cancel(secret: string): void {
    this.requests.delete(digest(secret))
  }
  inspect(code: string): { name: string; expires: number; remember: boolean } {
    this.prune()
    const row = [...this.requests.values()].find((x) => x.code === code)
    if (!row) throw new Error('配对码无效或已过期')
    return { name: row.name, expires: row.expires, remember: row.remember }
  }
  decide(code: string, approve: boolean): void {
    this.inspect(code)
    const row = [...this.requests.values()].find((x) => x.code === code)!
    if (!approve) this.requests.delete(row.secret)
    else {
      row.approved = true
      row.expires = Math.min(row.expires, this.now() + 60_000)
    }
  }
  poll(secret: string): PairRequest | null {
    this.prune()
    const row = this.requests.get(digest(secret))
    if (!row) throw new Error('配对已结束，请重新发起')
    if (row.nextPoll > this.now()) throw new Error('请稍后查询配对结果')
    row.nextPoll = this.now() + 5000
    if (!row.approved) return null
    this.requests.delete(row.secret)
    return row
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
