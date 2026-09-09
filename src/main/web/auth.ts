import {
  createHash,
  randomBytes,
  scrypt as derive,
  timingSafeEqual
} from 'node:crypto'
import fs from 'node:fs'
import { randomInt } from 'node:crypto'
import type { WebDevice, WebPairState } from '../../shared/webTypes'
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

interface SessionEntry extends Omit<WebDevice, 'expires'> {
  digest: string
}
/** Persistent records contain hashes only; unremembered sessions never reach disk. */
export class WebSessions {
  private sessions = new Map<string, SessionEntry>()
  constructor(
    private readonly now = Date.now,
    private readonly file?: string,
    load = true
  ) {
    if (load && file && fs.existsSync(file)) {
      const rows: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(rows) || rows.length > 100)
        throw new Error('设备记录无效')
      for (const row of rows) {
        if (
          !row ||
          typeof row.digest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(row.digest) ||
          typeof row.id !== 'string' ||
          !/^[a-f0-9]{32}$/.test(row.id) ||
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
  private save(rows = this.sessions): void {
    if (!this.file) return
    const temporary = `${this.file}.${randomBytes(8).toString('hex')}.tmp`
    try {
      fs.writeFileSync(
        temporary,
        JSON.stringify([...rows.values()].filter((x) => x.remember)),
        { mode: 0o600, flag: 'wx' }
      )
      fs.renameSync(temporary, this.file)
    } catch {
      throw new Error(
        '设备记录保存失败，操作未生效。请检查磁盘空间和目录权限后重试。'
      )
    } finally {
      try {
        fs.rmSync(temporary, { force: true })
      } catch {
        /* Preserve the original write result. */
      }
    }
  }
  private commit(update: (rows: Map<string, SessionEntry>) => void): void {
    const next = new Map(this.sessions)
    update(next)
    this.save(next)
    this.sessions = next
  }
  static reset(file: string): WebSessions {
    // Write an empty snapshot without parsing the damaged record.
    const store = new WebSessions(Date.now, file, false)
    store.save()
    return new WebSessions(Date.now, file)
  }

  private prune(): void {
    for (const [key, row] of this.sessions) {
      if (
        !row.remember && (this.now() - row.touched >= IDLE_MS ||
        this.now() - row.created >= LIFETIME_MS)
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
    this.commit((rows) =>
      rows.set(key, {
        digest: key,
        id: randomBytes(16).toString('hex'),
        name: name.slice(0, 80),
        remember,
        created: this.now(),
        touched: this.now()
      })
    )
    return token
  }
  check(token: string): boolean {
    this.prune()
    const row = this.sessions.get(digest(token))
    if (!row) return false
    // Activity is advisory: a failed timestamp write must not invalidate a credential.
    // Update memory first so idle expiry and write throttling still follow real use.
    if (this.now() - row.touched >= 60_000) {
      this.sessions.set(digest(token), { ...row, touched: this.now() })
      try {
        this.save()
      } catch {
        console.warn('[web] 设备活动时间保存失败，保留当前授权并在后续活动时重试。')
      }
    }
    return true
  }
  isRemembered(token: string): boolean {
    return this.sessions.get(digest(token))?.remember === true
  }
  idFor(token: string): string | undefined {
    this.prune()
    return this.sessions.get(digest(token))?.id
  }
  revoke(token: string): void {
    this.commit((rows) => {
      rows.delete(digest(token))
    })
  }
  remove(id: string): void {
    this.commit((rows) => {
      for (const [key, row] of rows) if (row.id === id) rows.delete(key)
    })
  }
  rename(id: string, name: string): void {
    const clean = name.trim()
    if (!clean || clean.length > 80) throw new Error('设备名称需为 1–80 个字符')
    this.commit((rows) => {
      const found = [...rows.entries()].find(([, row]) => row.id === id)
      if (!found) throw new Error('设备已失效，请刷新列表')
      rows.set(found[0], { ...found[1], name: clean })
    })
  }
  clear(): void {
    this.commit((rows) => rows.clear())
  }
  suspend(): void {
    this.commit((rows) => {
      for (const [key, row] of rows) if (!row.remember) rows.delete(key)
    })
  }
  list(): WebDevice[] {
    this.prune()
    return [...this.sessions.values()].map(
      ({ id, name, remember, created, touched }) => ({
        id,
        name,
        remember,
        created,
        touched,
        expires: remember ? null : Math.min(created + LIFETIME_MS, touched + IDLE_MS)
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
  private outcomes = new Map<
    string,
    { name: string; state: 'connected'; expires: number }
  >()
  constructor(private readonly now = Date.now) {}
  open(): void {
    this.until = this.now() + 5 * 60_000
  }
  get enabledUntil(): number {
    return this.until > this.now() ? this.until : 0
  }
  clear(): void {
    this.requests.clear()
    this.outcomes.clear()
    this.until = 0
  }
  private prune(): void {
    for (const [code, row] of this.outcomes)
      if (row.expires <= this.now()) this.outcomes.delete(code)
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
  status(secret: string): WebPairState {
    this.prune()
    const row = this.requests.get(digest(secret))
    if (!row) throw new Error('配对已结束，请重新发起')
    return {
      code: row.code,
      remainingMs: row.expires - this.now(),
      state: row.approved ? 'approved' : 'pending'
    }
  }
  activity(): {
    code: string
    name: string
    state: 'approved' | 'connected'
  }[] {
    this.prune()
    return [
      ...[...this.requests.values()]
        .filter((x) => x.approved)
        .map((x) => ({
          code: x.code,
          name: x.name,
          state: 'approved' as const
        })),
      ...[...this.outcomes].map(([code, row]) => ({
        code,
        name: row.name,
        state: row.state
      }))
    ]
  }
  connected(code: string, name: string): void {
    this.outcomes.set(code, {
      name,
      state: 'connected',
      expires: this.now() + 60_000
    })
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
  poll(
    secret: string,
    commit?: (row: PairRequest) => void
  ): PairRequest | null {
    this.prune()
    const row = this.requests.get(digest(secret))
    if (!row) throw new Error('配对已结束，请重新发起')
    if (row.nextPoll > this.now()) throw new Error('请稍后查询配对结果')
    row.nextPoll = this.now() + 5000
    if (!row.approved) return null
    commit?.(row)
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
