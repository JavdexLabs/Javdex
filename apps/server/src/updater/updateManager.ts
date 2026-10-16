import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import semver from 'semver'
import { UPDATE_PHASES, signedUpdateSchema, updateManifestSchema, type SignedServerUpdate, type ServerUpdateManifest, type ServerUpdateSnapshot, type ServerUpdateJob, type ServerUpdatePhase } from '@shared/serverUpdateTypes'
import type { DeploymentRelease, DeploymentSnapshot, UpdateDeployment } from './deployment'
import { checkUpdateTarget, verifyUpdateManifest } from './manifest'
import { readJsonIfExists, syncDirectory, writeJsonAtomic } from './files'

const imageReleaseSchema = updateManifestSchema.pick({ version: true, build: true, platform: true, runtime: true, targetSchema: true, sourceSchemas: true })
  .extend({ archive: updateManifestSchema.shape.archive.pick({ sha256: true }), environmentVersion: updateManifestSchema.shape.environmentVersion.optional() }).strict()
// After commit, recovery only activates the already selected release. Do not
// re-admit historical signed bundles through the new installation contract.
const committedManifestSchema = updateManifestSchema.extend({ environmentVersion: updateManifestSchema.shape.environmentVersion.optional() })
const jobSchema = z.object({
  id: z.uuid(), version: z.string(), phase: z.enum([...UPDATE_PHASES, 'backup', 'restoring', 'restored']),
  receivedBytes: z.number().int().nonnegative(), totalBytes: z.number().int().positive(), updatedAt: z.iso.datetime(), message: z.string().nullable(),
  signed: signedUpdateSchema.nullable(),
  image: imageReleaseSchema.optional(),
  deployment: z.unknown().nullable(),
  offline: z.boolean()
}).strict().refine(job => Boolean(job.signed) !== Boolean(job.image), '更新来源必须唯一')
type StoredJob = Omit<z.infer<typeof jobSchema>, 'phase' | 'deployment'> & { phase: ServerUpdatePhase; deployment: DeploymentSnapshot | null }
const terminal = new Set(['complete', 'failed'])

function readCurrentJob(value: unknown): StoredJob {
  const saved = jobSchema.parse(value)
  // Read published journals without resuming the removed snapshot workflow.
  // Leave the original journal and recovery materials untouched on disk.
  if (saved.phase === 'restored') return { ...saved, phase: 'failed', message: '旧版升级已回退，原服务保留；可重新检查升级' } as StoredJob
  if (saved.phase === 'backup' || saved.phase === 'restoring') return { ...saved, phase: 'recoveryRequired', message: '旧版升级在备份或恢复期间中断，请保留程序卷及资料并人工核对' } as StoredJob
  return saved as StoredJob
}

export class ServerUpdateManager {
  private busy = false
  private controlBusy = false
  private target: SignedServerUpdate | null = null
  private job: StoredJob | null = null
  private identity: DeploymentSnapshot | null = null
  private shuttingDown = false
  private work: Promise<void> | null = null
  constructor(private readonly directory: string, private readonly keys: Record<string, string>, private readonly deployment: UpdateDeployment) {
    fs.mkdirSync(path.join(directory, 'jobs'), { recursive: true, mode: 0o700 })
    const saved = readJsonIfExists(path.join(directory, 'current.json'))
    if (saved) this.job = readCurrentJob(saved)
    if (this.job?.phase === 'preparing' && this.job.offline) {
      const archive = path.join(directory, 'jobs', this.job.id, 'release.tar.gz')
      if (fs.existsSync(archive)) {
        if (fs.statSync(archive).size < this.job.receivedBytes) throw new Error('上传暂存文件不完整，请核对助手状态目录')
        fs.truncateSync(archive, this.job.receivedBytes)
      }
      else if (this.job.receivedBytes) throw new Error('上传暂存文件缺失，请核对助手状态目录')
    }
    const target = readJsonIfExists(path.join(directory, 'target.json'))
    if (target) this.target = signedUpdateSchema.parse(target)
  }
  private jobDir(): string {
    if (!this.job) throw new Error('没有更新任务')
    return path.join(this.directory, 'jobs', this.job.id)
  }
  private save(phase?: StoredJob['phase'], message: string | null = null, changes: Partial<Pick<StoredJob, 'receivedBytes' | 'deployment'>> = {}): void {
    if (!this.job) return
    const next = { ...this.job, ...changes, ...(phase ? { phase } : {}), updatedAt: new Date().toISOString(), message }
    const current = path.join(this.directory, 'current.json')
    try { writeJsonAtomic(current, next) }
    catch (error) {
      // A failure before rename leaves the old journal; failure after rename is
      // uncertain. Read the authoritative record before deciding to roll back.
      try {
        const saved = readJsonIfExists(current)
        this.job = saved ? readCurrentJob(saved) : null
      } catch { this.job = { ...next, phase: 'recoveryRequired', message: '更新记录无法确认，请保留现场并人工核对' } }
      throw error
    }
    this.job = next
    // This copy is cleanup metadata, never the commit or upload authority.
    try { writeJsonAtomic(path.join(this.jobDir(), 'job.json'), next) }
    catch { console.warn('更新任务归档写入失败，保留当前任务和旧记录以供检查') }
  }
  private assertIdle(): void {
    if (this.shuttingDown || this.busy || (this.job && !terminal.has(this.job.phase) && !['prepared', 'preparing'].includes(this.job.phase))) throw new Error('已有更新任务正在执行或需要人工恢复')
  }
  private async control<T>(operation: () => Promise<T>): Promise<T> {
    if (this.controlBusy) throw new Error('已有更新请求正在处理')
    this.controlBusy = true
    try { return await operation() } finally { this.controlBusy = false }
  }
  /** Local image startup only; never exposed by the HTTP control dispatcher. */
  installImage(release: DeploymentRelease, bytes: number, prepare: () => Promise<void>): Promise<void> {
    return this.control(async () => {
      this.assertIdle()
      // Do not replace an administrator's prepared/uploading job on restart.
      if (this.job && !terminal.has(this.job.phase)) return
      const image = imageReleaseSchema.parse(release)
      const current = await this.deployment.inspect()
      if (!semver.valid(current.identity.version)) throw new Error('当前业务版本无效')
      if (!semver.gt(image.version, current.identity.version)) return
      const attemptsFile = path.join(this.directory, 'image-attempts.json')
      const attempts = z.array(z.string().regex(/^[a-f0-9]{64}$/)).parse(readJsonIfExists(attemptsFile) ?? [])
      if (attempts.includes(image.archive.sha256)) return
      if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('镜像发行大小无效')
      this.identity = current
      this.job = { id: randomUUID(), version: image.version, phase: 'preparing', receivedBytes: 0, totalBytes: bytes,
        updatedAt: new Date().toISOString(), message: null, signed: null, image, deployment: current, offline: false }
      fs.mkdirSync(this.jobDir(), { mode: 0o700 })
      syncDirectory(path.join(this.directory, 'jobs'))
      this.save('preparing')
      // Reserve before any preparation or destructive work, surviving even SIGKILL.
      writeJsonAtomic(attemptsFile, [...attempts, image.archive.sha256])
      this.busy = true
      this.work = (async () => {
        try {
          checkUpdateTarget(image, current.identity)
          if (current.identity.busy) throw new Error('服务端有未完成的扫描或维护任务')
          const space = fs.statfsSync(this.directory)
          if (Number(space.bavail) * Number(space.bsize) < bytes + 256 * 1024 ** 2) throw new Error('镜像升级空间不足')
          await prepare()
          if (this.shuttingDown) return
          this.save('stopping')
        } catch (error) { this.save('failed', `镜像升级未执行：${(error as Error).message}；请处理原因后通过客户端更新`); return }
        await this.execute(image, current)
      })().finally(() => { this.busy = false })
      await this.work
    })
  }
  async status(refresh = true): Promise<ServerUpdateSnapshot> {
    if (refresh && !this.busy && (!this.job || terminal.has(this.job.phase) || ['preparing', 'prepared'].includes(this.job.phase))) this.identity = await this.deployment.inspect()
    const identity = this.identity ?? this.job?.deployment
    let targetVersion: string | null = null
    try {
      if (this.target) {
        const version = verifyUpdateManifest(this.target, this.keys).version
        if (version !== identity?.identity.version) targetVersion = version
      }
    } catch { /* Expired metadata is not an installable target. */ }
    const job: ServerUpdateJob | null = this.job ? {
      id: this.job.id, version: this.job.version, phase: this.job.phase, receivedBytes: this.job.receivedBytes,
      totalBytes: this.job.totalBytes, updatedAt: this.job.updatedAt, message: this.job.message,
      resumableUpload: this.job.phase === 'preparing' && this.job.offline
    } : null
    return { protocolVersion: 1, paired: true, serverId: identity?.identity.serverId ?? null, catalogId: identity?.identity.catalogId ?? null, currentVersion: identity?.identity.version ?? null, platform: identity?.identity.platform ?? null, runtime: identity?.identity.runtime ?? null, targetVersion, job }
  }
  setTarget(signed: unknown, expectedVersion?: string): Promise<ServerUpdateSnapshot> { return this.control(() => this.selectTarget(signed, expectedVersion)) }
  private async selectTarget(signed: unknown, expectedVersion?: string): Promise<ServerUpdateSnapshot> {
    this.assertIdle()
    const manifest = verifyUpdateManifest(signed, this.keys)
    this.requireTargetVersion(manifest.version, expectedVersion)
    const deployment = await this.deployment.inspect()
    if (manifest.version === deployment.identity.version && manifest.platform === deployment.identity.platform) {
      this.identity = deployment
      this.target = null
      writeJsonAtomic(path.join(this.directory, 'target.json'), null)
      return this.status(false)
    }
    checkUpdateTarget(manifest, deployment.identity)
    this.identity = deployment
    this.target = signedUpdateSchema.parse(signed)
    writeJsonAtomic(path.join(this.directory, 'target.json'), this.target)
    return this.status(false)
  }
  private requireTargetVersion(version: string, expected?: string): void {
    if (expected && version !== expected) throw new Error(`升级包版本必须与此客户端 ${expected} 一致`)
  }
  private async createJob(offline: boolean): Promise<ServerUpdateManifest> {
    this.assertIdle()
    if (!this.target) throw new Error('请先检查更新或选择签名清单')
    const signed = this.target
    const manifest = verifyUpdateManifest(signed, this.keys)
    const current = await this.deployment.inspect()
    checkUpdateTarget(manifest, current.identity)
    if (current.identity.busy) throw new Error('服务端有扫描或维护任务，请完成后重试')
    // Only program staging space is reserved; library data is never copied.
    const stat = fs.statfsSync(this.directory)
    const resume = offline && this.job?.phase === 'preparing' && this.job.offline && this.job.signed?.payload === signed.payload
    const remaining = manifest.archive.bytes - (resume ? this.job!.receivedBytes : 0)
    if (Number(stat.bavail) * Number(stat.bsize) < remaining + manifest.archive.unpackedBytes + 256 * 1024 ** 2) throw new Error('更新暂存空间不足')
    if (resume) return manifest
    this.identity = current
    this.job = { id: randomUUID(), version: manifest.version, phase: 'preparing', receivedBytes: 0, totalBytes: manifest.archive.bytes, updatedAt: new Date().toISOString(), message: null, signed, deployment: current, offline }
    fs.mkdirSync(this.jobDir(), { mode: 0o700 })
    syncDirectory(path.join(this.directory, 'jobs'))
    this.save('preparing')
    return manifest
  }
  beginOffline(signed: unknown, expectedVersion?: string): Promise<ServerUpdateSnapshot> { return this.control(() => this.beginOfflineLocked(signed, expectedVersion)) }
  private async beginOfflineLocked(signed: unknown, expectedVersion?: string): Promise<ServerUpdateSnapshot> {
    await this.selectTarget(signed, expectedVersion)
    if (this.job?.phase === 'prepared' && this.job.offline && this.job.signed?.payload === this.target?.payload) return this.status(false)
    await this.createJob(true)
    if (this.job && this.job.receivedBytes === this.job.totalBytes) await this.completeOffline()
    return this.status(false)
  }
  prepare(expectedVersion?: string): Promise<ServerUpdateSnapshot> { return this.control(() => this.prepareLocked(expectedVersion)) }
  private async prepareLocked(expectedVersion?: string): Promise<ServerUpdateSnapshot> {
    if (this.target) this.requireTargetVersion(verifyUpdateManifest(this.target, this.keys).version, expectedVersion)
    if (this.busy) throw new Error('已有更新任务正在准备')
    if (this.job?.phase === 'prepared' && this.job.signed?.payload === this.target?.payload) return this.status(false)
    const manifest = await this.createJob(false)
    this.busy = true
    this.work = this.deployment.prepare(manifest).then(() => { if (!this.shuttingDown) this.save('prepared') }, () => { if (!this.shuttingDown) this.save('failed', '发行包准备失败，原服务继续运行') }).finally(() => { this.busy = false })
    return this.status(false)
  }
  async upload(id: string, offset: number, request: AsyncIterable<Buffer>): Promise<ServerUpdateSnapshot> {
    if (this.controlBusy || this.busy || !this.job || this.job.id !== id || this.job.phase !== 'preparing' || !this.job.offline) throw new Error('上传任务不可用')
    if (offset !== this.job.receivedBytes) throw new Error('上传偏移不一致，请查询任务后续传')
    verifyUpdateManifest(this.job.signed, this.keys)
    this.busy = true
    const file = path.join(this.jobDir(), 'release.tar.gz')
    let fd: number | undefined
    let length = 0
    try {
      fd = fs.openSync(file, fs.existsSync(file) ? 'r+' : 'w', 0o600)
      for await (const chunk of request) {
        length += chunk.length
        if (length > 8 * 1024 ** 2 || offset + length > this.job.totalBytes) throw new Error('上传分块超过允许大小')
        fs.writeSync(fd, chunk, 0, chunk.length, offset + length - chunk.length)
      }
      fs.fsyncSync(fd)
      syncDirectory(this.jobDir())
      this.save(undefined, null, { receivedBytes: offset + length })
    } catch (error) {
      if (fd !== undefined) fs.ftruncateSync(fd, this.job?.receivedBytes ?? offset)
      throw error
    } finally { try { if (fd !== undefined) fs.closeSync(fd) } finally { this.busy = false } }
    if (this.job.receivedBytes === this.job.totalBytes) await this.completeOffline()
    return this.status(false)
  }
  private async completeOffline(): Promise<void> {
    this.busy = true
    try {
      this.work = this.finishOffline(path.join(this.jobDir(), 'release.tar.gz'))
      await this.work
    } catch (error) { this.save('failed', (error as Error).message); throw error }
    finally { this.busy = false }
  }
  private async finishOffline(file: string): Promise<void> {
    const manifest = verifyUpdateManifest(this.job!.signed, this.keys)
    const hash = createHash('sha256')
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
    if (hash.digest('hex') !== manifest.archive.sha256) throw new Error('离线更新包校验失败')
    await this.deployment.prepare(manifest, file)
    this.save('prepared')
  }
  install(id: string, expectedVersion?: string): Promise<ServerUpdateSnapshot> { return this.control(() => this.installLocked(id, expectedVersion)) }
  private async installLocked(id: string, expectedVersion?: string): Promise<ServerUpdateSnapshot> {
    if (this.job?.id === id) this.requireTargetVersion(this.job.version, expectedVersion)
    if (this.job?.id === id && ['stopping', 'installing', 'verifying', 'activating', 'complete'].includes(this.job.phase)) return this.status(false)
    if (this.shuttingDown || this.busy || !this.job || this.job.id !== id || this.job.phase !== 'prepared') throw new Error('请先完成更新包准备')
    const manifest = verifyUpdateManifest(this.job.signed, this.keys)
    const current = await this.deployment.inspect()
    checkUpdateTarget(manifest, current.identity)
    if (current.identity.busy) throw new Error('服务端有扫描或维护任务，请完成后重试')
    const space = fs.statfsSync(this.directory)
    if (Number(space.bavail) * Number(space.bsize) < 256 * 1024 ** 2) throw new Error('升级所需空间不足')
    const prepared = this.job.deployment
    if (!prepared || prepared.release !== current.release || prepared.configHash !== current.configHash || prepared.identity.serverId !== current.identity.serverId || prepared.identity.catalogId !== current.identity.catalogId || prepared.identity.dataDir !== current.identity.dataDir || prepared.identity.imagesDir !== current.identity.imagesDir || JSON.stringify(prepared.roots) !== JSON.stringify(current.roots)) throw new Error('准备后部署已变化，请重新检查更新')
    this.save('stopping', null, { deployment: current })
    this.busy = true
    this.work = this.execute(manifest, current).finally(() => { this.busy = false })
    return this.status(false)
  }
  private async execute(manifest: DeploymentRelease, current: DeploymentSnapshot): Promise<void> {
    try {
      await this.deployment.stop()
      if (this.shuttingDown) return
      this.save('installing')
      await this.deployment.install(manifest, this.job!.id, current)
      if (this.shuttingDown) return
      this.save('verifying')
      await this.deployment.verify(manifest, current)
      if (this.shuttingDown) return
      // Durable commit before releasing business access. Never roll back new writes.
      this.save('activating')
      await this.deployment.activate(this.job!.id, manifest, current)
      this.identity = await this.deployment.inspect()
      this.save('complete')
      if (!this.cleanPreviousJobs()) this.save('complete', '更新已完成，旧任务清理未完成；新服务继续运行，请核对程序卷空间')
      else {
        try { await this.deployment.cleanup(current) }
        catch { this.save('complete', '更新已完成，旧发行目录保留以供检查；请核对程序卷空间') }
      }
    } catch (error) {
      if (this.shuttingDown) return
      if (this.job && ['activating', 'complete', 'recoveryRequired'].includes(this.job.phase)) { this.save('recoveryRequired', '提交状态或开放业务状态需要人工核对；不会自动回退资料库'); return }
      await this.handleFailure(current, error)
    }
  }
  private async handleFailure(current: DeploymentSnapshot, reason: unknown): Promise<void> {
    if (this.job?.phase !== 'stopping') {
      try { await this.deployment.stop() } catch { /* Persist manual recovery even if stopping failed. */ }
      this.save('recoveryRequired', '升级失败或中断；资料库可能已迁移，服务保持维护状态，请保留现场并人工恢复。原因：' + (reason as Error).message)
      return
    }
    // Installation has not started, so only restart the unchanged original service.
    try {
      await this.deployment.resume(current)
      if (this.shuttingDown) return
      this.identity = await this.deployment.inspect()
      this.save('failed', '升级未执行，原服务已恢复运行。原因：' + (reason as Error).message)
    } catch { if (!this.shuttingDown) this.save('recoveryRequired', '原服务未能恢复运行，请保留现场并核对容器日志') }
  }
  private cleanPreviousJobs(): boolean {
    // Only completed, updater-owned UUID directories; never touch user exports.
    let success = true
    try {
      for (const id of fs.readdirSync(path.join(this.directory, 'jobs'))) {
        if (id === this.job?.id) continue
        if (!z.uuid().safeParse(id).success) { success = false; continue }
        try {
          const directory = path.join(this.directory, 'jobs', id)
          if (!fs.lstatSync(directory).isDirectory()) continue
          const saved = jobSchema.safeParse(readJsonIfExists(path.join(directory, 'job.json')))
          if (saved.success && saved.data.id === id && terminal.has(saved.data.phase)) fs.rmSync(directory, { recursive: true, force: true })
          else success = false
        } catch { success = false }
      }
    } catch { success = false }
    return success
  }
  async recover(): Promise<void> {
    if (this.job?.phase === 'preparing' && !this.job.offline) this.save('failed', '发行包准备被中断，请重新准备；原服务未切换')
    if (this.job?.phase === 'preparing' && this.job.offline && this.job.receivedBytes === this.job.totalBytes) {
      this.busy = true
      try { await this.finishOffline(path.join(this.jobDir(), 'release.tar.gz')) }
      catch { this.save('failed', '离线包准备中断或校验失败，请重新选择官方包') }
      finally { this.busy = false }
    }
    if (!this.job || ['preparing', 'prepared', 'complete', 'failed', 'recoveryRequired'].includes(this.job.phase)) return
    this.busy = true
    try {
      if (this.job.phase === 'activating' && this.job.deployment) {
        await this.deployment.activate(this.job.id, this.job.image ?? committedManifestSchema.parse(JSON.parse(this.job.signed!.payload)), this.job.deployment)
        this.identity = await this.deployment.inspect()
        this.save('complete')
      } else if (this.job.deployment) await this.handleFailure(this.job.deployment, new Error('升级管理器重启，安装被中断'))
      else this.save('recoveryRequired', '缺少原部署记录，请人工恢复')
    } catch { if (!this.shuttingDown) this.save('recoveryRequired', '更新恢复需要人工核对') }
    finally { this.busy = false }
  }
  get recoveryRequired(): boolean { return this.job?.phase === 'recoveryRequired' }
  async shutdown(): Promise<void> { this.shuttingDown = true; await this.work }
}

export async function readLimitedJson(request: IncomingMessage, limit = 65536): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const part of request) {
    const chunk = Buffer.from(part)
    bytes += chunk.length
    if (bytes > limit) throw new Error('请求内容过大')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
