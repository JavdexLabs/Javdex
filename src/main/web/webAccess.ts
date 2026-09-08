import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { WebAccessInput, WebAccessStatus } from '@shared/webTypes'
import { getDb } from '../db/database'
import { hashPassword } from './auth'
import { WebCatalog } from './catalog'
import { localAddresses, WebServer } from './server'

interface StoredAccess {
  enabled: boolean
  port: number
  username: string
  passwordHash: string
}
const defaults: StoredAccess = {
  enabled: false,
  port: 8096,
  username: 'viewer',
  passwordHash: ''
}
class WebAccess {
  private config = { ...defaults }
  private server: WebServer | null = null
  private error: string | null = null
  private busy = false
  private file(): string {
    return path.join(app.getPath('userData'), 'web-access.json')
  }
  status(): WebAccessStatus {
    return {
      enabled: this.config.enabled,
      running: this.server !== null,
      port: this.config.port,
      username: this.config.username,
      hasPassword: Boolean(this.config.passwordHash),
      urls: this.server
        ? localAddresses().map((host) => `http://${host}:${this.config.port}`)
        : [],
      sessions: this.server?.sessionCount ?? 0,
      error: this.error
    }
  }
  private async listen(): Promise<void> {
    const staticRoot = path.join(app.getAppPath(), 'out/web')
    if (!fs.existsSync(path.join(staticRoot, 'index.html')))
      throw new Error('Web 页面未构建，请先运行 npm run web:build')
    const server = new WebServer({
      ...this.config,
      staticRoot,
      catalog: new WebCatalog(getDb())
    })
    try {
      await server.start(this.config.port)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
        throw new Error('端口已被占用，请更换端口后保存')
      throw new Error('Web 服务启动失败，请检查网络权限和端口')
    }
    this.server = server
  }
  async initialize(): Promise<void> {
    try {
      if (!fs.existsSync(this.file())) return
      const saved = JSON.parse(
        fs.readFileSync(this.file(), 'utf8')
      ) as StoredAccess
      if (
        typeof saved.enabled !== 'boolean' ||
        !Number.isInteger(saved.port) ||
        saved.port < 1024 ||
        saved.port > 65535 ||
        typeof saved.username !== 'string' ||
        !/^[\w.-]{1,64}$/.test(saved.username) ||
        typeof saved.passwordHash !== 'string' ||
        (saved.passwordHash &&
          !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(saved.passwordHash))
      )
        throw new Error('Web 配置无效，请重新保存')
      if (saved.enabled && !saved.passwordHash)
        throw new Error('启用 Web 访问前请设置密码')
      this.config = saved
      if (this.config.enabled) await this.listen()
    } catch (error) {
      this.error = (error as Error).message
    }
  }
  async apply(input: WebAccessInput): Promise<WebAccessStatus> {
    if (this.busy) throw new Error('Web 服务正在切换，请稍后重试')
    this.busy = true
    try {
      if (
        !Number.isInteger(input.port) ||
        input.port < 1024 ||
        input.port > 65535 ||
        !/^[\w.-]{1,64}$/.test(input.username)
      )
        throw new Error('请填写有效端口与账号（字母、数字、点、横线或下划线）')
      const passwordHash = input.password
        ? await hashPassword(input.password)
        : this.config.passwordHash
      if (input.enabled && !passwordHash)
        throw new Error('启用前请设置访问密码')
      const config: StoredAccess = {
        enabled: input.enabled,
        port: input.port,
        username: input.username,
        passwordHash
      }
      const temporary = `${this.file()}.tmp`
      fs.writeFileSync(temporary, JSON.stringify(config, null, 2), {
        mode: 0o600
      })
      fs.renameSync(temporary, this.file())
      await this.stop()
      this.config = config
      this.error = null
      if (config.enabled) {
        try {
          await this.listen()
        } catch (error) {
          this.error = (error as Error).message
        }
      }
      return this.status()
    } finally {
      this.busy = false
    }
  }
  revoke(): WebAccessStatus {
    this.server?.revokeSessions()
    return this.status()
  }
  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    await server?.stop()
  }
}
export const webAccess = new WebAccess()
