import path from 'node:path'
import fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { contained, type UpdaterConfig } from './config'
import { readJsonIfExists, writeJsonAtomic } from './files'
import { MANAGED_LOCK } from './storage'

function kernelLockFd(config: UpdaterConfig): number | null {
  if (process.platform !== 'linux' || process.env.JAVDEX_MANAGER_LOCK_HELD !== '1') return null
  const file = path.join(config.dataDir, MANAGED_LOCK)
  for (const value of fs.readdirSync('/proc/self/fd')) {
    const fd = Number(value)
    if (fd < 3) continue
    try { if (fs.readlinkSync(`/proc/self/fd/${fd}`) === file) return fd } catch { /* The fd may have just closed. */ }
  }
  throw new Error('托管资料库锁未继承，拒绝启动业务写入')
}
export function clearStaleManagedMarker(config: UpdaterConfig): void {
  if (kernelLockFd(config) === null) return
  const recorded = readJsonIfExists(path.join(config.stateDir, 'business-instance.json')) as { pid?: number; directory?: string } | null
  const file = path.join(config.dataDir, 'instance.lock')
  if (recorded && Number.isSafeInteger(recorded.pid) && recorded.pid! > 1 && recorded.directory && contained(recorded.directory, config.releasesDir) && fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() === String(recorded.pid)) fs.unlinkSync(file)
}

export class BusinessSupervisor {
  private child: ChildProcess | null = null
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private closing = false
  private restarts = 0
  private restartAllowed = false
  private retiring: Promise<void> = Promise.resolve()
  private launch: { directory: string; jobId?: string } | null = null
  constructor(private readonly config: UpdaterConfig) {}
  get running(): boolean { return this.child !== null }
  get pid(): number | null { return this.child?.pid ?? null }
  async start(directory: string, jobId?: string, restart = false): Promise<void> {
    await this.retiring
    if (this.closing) throw new Error('容器正在停止')
    if (this.child) throw new Error('业务进程尚未退出')
    clearTimeout(this.restartTimer)
    this.launch = { directory, jobId }; this.restartAllowed = restart
    const lockFd = kernelLockFd(this.config)
    const child = spawn(process.execPath, [path.join(directory, 'index.js'), 'start', '--config', this.config.serverConfigPath], {
      cwd: directory, detached: true, stdio: lockFd === null ? 'inherit' : ['inherit', 'inherit', 'inherit', lockFd],
      uid: this.config.businessUid, gid: this.config.businessGid,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', ELECTRON_RUN_AS_NODE: '1', JAVDEX_STATIC_ROOT: path.join(directory, 'web'), JAVDEX_UPDATE_JOB: jobId || '' }
    })
    this.child = child
    child.once('exit', () => {
      if (this.child === child) this.child = null
      this.retiring = this.drainGroup(child.pid!)
      void this.retiring.then(() => {
        if (!this.closing && this.restartAllowed && this.launch && this.restarts < 5) {
          const launch = this.launch
          this.restartTimer = setTimeout(() => { void this.start(launch.directory, launch.jobId, true).catch(() => { this.restartAllowed = false }) }, Math.min(30000, 1000 * 2 ** this.restarts++))
        }
      }, () => { this.restartAllowed = false })
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => {
        try { writeJsonAtomic(path.join(this.config.stateDir, 'business-instance.json'), { pid: child.pid, directory }); resolve() }
        catch (error) { reject(error) }
      })
      child.once('error', error => { if (this.child === child) this.child = null; reject(error) })
    })
  }
  allowRestart(): void { this.restarts = 0; this.restartAllowed = true }
  private async drainGroup(pid: number): Promise<void> {
    try { process.kill(-pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error }
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      try { process.kill(-pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('业务进程组未完全退出，不能开始备份或启动第二个写入进程')
  }
  async stop(): Promise<void> {
    this.restartAllowed = false; clearTimeout(this.restartTimer)
    const child = this.child
    if (!child?.pid) { await this.retiring; return }
    const kill = (signal: NodeJS.Signals): void => {
      try { process.kill(-child.pid!, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { try { kill('SIGKILL') } catch (error) { reject(error) } }, this.config.stopTimeoutSeconds * 1000)
      child.once('exit', () => { clearTimeout(timeout); resolve() })
      try { kill('SIGTERM') } catch (error) { clearTimeout(timeout); reject(error) }
    })
    await this.retiring
  }
  async shutdown(): Promise<void> { this.closing = true; await this.stop() }
}
