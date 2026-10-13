import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ServerUpdateManifest } from '@shared/serverUpdateTypes'
import { SERVER_RUNTIME_ID } from '@shared/serverUpdateTypes'
import { contained, type UpdaterConfig } from './config'
import type { DeploymentIdentity, DeploymentSnapshot, UpdateDeployment } from './deployment'
import { ReleaseStore, fileHash, releaseId } from './releaseStore'
import { BusinessSupervisor } from './supervisor'
import { copyTree, restoreTree, treeBytes, treeHash } from './storage'
import { readJsonIfExists, syncDirectory, writeJsonAtomic } from './files'
import { requestBusiness } from './businessHttp'

const run = promisify(execFile)
const identitySchema = z.object({ schema: z.number().int().positive(), serverId: z.uuid(), catalogId: z.uuid(), busy: z.boolean() }).strict()
const snapshotSchema = z.object({ format: z.literal(1), release: z.string(), configHash: z.string(), roots: z.array(z.string()), hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)) }).strict()
export class ProcessUpdateDeployment implements UpdateDeployment {
  private readonly configHash: Promise<string>
  constructor(private readonly config: UpdaterConfig, readonly releases: ReleaseStore, readonly supervisor: BusinessSupervisor,
    private readonly options: { probe?: (directory: string) => Promise<z.infer<typeof identitySchema>>; readyTimeoutMs?: number } = {}) {
    this.configHash = fileHash(config.serverConfigPath)
  }
  private async roots(): Promise<string[]> {
    const roots = [this.config.dataDir, ...(contained(this.config.imagesDir, this.config.dataDir) ? [] : [this.config.imagesDir])]
    for (const root of roots) {
      if (root === path.parse(root).root || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error('资料和图片必须是明确的独立目录')
      const real = fs.realpathSync(root)
      if (real !== root) throw new Error('资料或图片目录身份已变化，请核对原目录')
      const program = fs.realpathSync(this.config.runtimeDir)
      if (contained(real, program) || contained(program, real)) throw new Error('资料与程序卷不能互相包含')
    }
    return roots
  }
  private async probe(directory: string): Promise<z.infer<typeof identitySchema>> {
    if (this.options.probe) return identitySchema.parse(await this.options.probe(directory))
    const script = `const fs=require('node:fs');const path=require('node:path');const r=require('node:module').createRequire(process.argv[1]);const D=r('better-sqlite3');const data=process.argv[2];const d=new D(path.join(data,'library.db'),{readonly:true,fileMustExist:true});const id=d.prepare('SELECT server_id,catalog_id,frozen FROM catalog_identity WHERE id=1').get();if(!id||!id.server_id)throw Error('Catalog not initialized');let busy=Boolean(id.frozen)||Boolean(d.prepare("SELECT 1 FROM library_scan_runs WHERE status IN ('queued','running') LIMIT 1").get())||Boolean(d.prepare("SELECT 1 FROM catalog_tasks WHERE state IN ('queued','running','cancelRequested','needsInspection') LIMIT 1").get())||Boolean(d.prepare("SELECT 1 FROM catalog_settings WHERE key LIKE 'catalog-mutation-intent:%' OR key LIKE 'catalog-file-maintenance:%' LIMIT 1").get());const operations=path.join(data,'backups','operations');if(fs.existsSync(operations))for(const entry of fs.readdirSync(operations)){const f=path.join(operations,entry,'job.json');if(!fs.existsSync(f))continue;const j=JSON.parse(fs.readFileSync(f,'utf8'));if(!['completed','succeeded','failed','cancelled'].includes(j.phase))busy=true}console.log(JSON.stringify({schema:d.pragma('user_version',{simple:true}),serverId:id.server_id,catalogId:id.catalog_id,busy}));d.close();`
    const result = await run(process.execPath, ['-e', script, path.join(directory, 'package.json'), this.config.dataDir], {
      timeout: 15000, maxBuffer: 65536, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', ELECTRON_RUN_AS_NODE: '1' }
    }).catch(() => { throw new Error('无法读取资料库身份，请核对业务状态和原生依赖') })
    return identitySchema.parse(JSON.parse(result.stdout))
  }
  async inspect(options: { measure?: boolean } = {}): Promise<DeploymentSnapshot> {
    if (await fileHash(this.config.serverConfigPath) !== await this.configHash) throw new Error('配置已变化，请先重新启动容器再更新')
    const release = this.releases.current()
    if (!release) throw new Error('服务端发行包尚未初始化')
    const directory = this.releases.directory(release)
    const descriptor = this.releases.descriptor(directory)
    const roots = await this.roots()
    const database = await this.probe(directory)
    let estimatedBytes = 0
    if (options.measure) for (const root of roots) estimatedBytes += await treeBytes(root, { excludeRootLock: root === this.config.dataDir })
    const identity: DeploymentIdentity = { ...database, version: descriptor.version, platform: descriptor.platform, runtime: SERVER_RUNTIME_ID,
      dataDir: this.config.dataDir, imagesDir: this.config.imagesDir, busy: database.busy, estimatedBytes, port: Number(new URL(this.config.serverUrl).port) }
    return { identity, release, roots, configHash: await this.configHash }
  }
  async prepare(manifest: ServerUpdateManifest, archive?: string): Promise<void> {
    if (archive) { await this.releases.prepare(manifest, archive); return }
    const file = path.join(this.config.stateDir, `download-${manifest.archive.sha256}.tar.gz`)
    const response = await fetch(manifest.archive.url, { signal: AbortSignal.timeout(15 * 60_000) })
    if (!response.ok || !response.body) throw new Error('官方发行包下载失败')
    const fd = fs.openSync(file, 'w', 0o600)
    let bytes = 0
    try {
      for await (const part of response.body) {
        bytes += part.length
        if (bytes > manifest.archive.bytes) throw new Error('发行包超过签名声明的大小')
        fs.writeSync(fd, part)
      }
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    await this.releases.prepare(manifest, file)
    fs.unlinkSync(file)
  }
  async stop(): Promise<void> { await this.supervisor.stop() }
  async cleanup(original: DeploymentSnapshot): Promise<void> {
    const current = this.releases.current()
    if (!current) throw new Error('当前发行记录缺失，停止清理')
    await this.releases.retain(current, original.release)
  }
  private async validateOriginal(original: DeploymentSnapshot): Promise<void> {
    if (!original || original.configHash !== await this.configHash || await fileHash(this.config.serverConfigPath) !== original.configHash || JSON.stringify(original.roots) !== JSON.stringify(await this.roots()) || original.identity.dataDir !== this.config.dataDir || original.identity.imagesDir !== this.config.imagesDir) throw new Error('恢复记录与当前资料库配置不一致')
    const descriptor = this.releases.descriptor(this.releases.directory(original.release))
    if (descriptor.version !== original.identity.version || descriptor.platform !== original.identity.platform) throw new Error('原发行记录损坏')
  }
  async backup(jobDir: string, original: DeploymentSnapshot): Promise<void> {
    if (this.supervisor.running) throw new Error('必须先停止全部业务写入')
    await this.validateOriginal(original)
    const stopped = await this.inspect({ measure: true })
    if (stopped.identity.busy || stopped.identity.serverId !== original.identity.serverId || stopped.identity.catalogId !== original.identity.catalogId || stopped.identity.schema !== original.identity.schema) throw new Error('停机后仍有维护任务或资料库身份已变化')
    const snapshot = path.join(jobDir, 'snapshot')
    fs.mkdirSync(snapshot, { recursive: true, mode: 0o700 })
    const hashes: string[] = []
    for (let i = 0; i < original.roots.length; i++) {
      const destination = path.join(snapshot, `root-${i}`)
      await copyTree(original.roots[i], destination, { excludeRootLock: original.roots[i] === this.config.dataDir })
      hashes.push(await treeHash(destination))
    }
    await copyTree(this.config.serverConfigPath, path.join(snapshot, 'server-config.json'))
    if (await fileHash(path.join(snapshot, 'server-config.json')) !== original.configHash) throw new Error('快照配置与原部署不一致')
    syncDirectory(snapshot)
    writeJsonAtomic(path.join(jobDir, 'snapshot-complete.json'), { format: 1, release: original.release, configHash: original.configHash, roots: original.roots, hashes })
  }
  async install(manifest: ServerUpdateManifest, jobId: string, original: DeploymentSnapshot): Promise<void> {
    if (this.supervisor.running) throw new Error('旧业务进程尚未退出')
    await this.validateOriginal(original)
    await this.releases.verify(this.releases.directory(releaseId(manifest)), manifest)
    writeJsonAtomic(path.join(this.config.dataDir, 'server-update-guard.json'), { id: jobId, phase: 'verifying' })
    fs.chmodSync(path.join(this.config.dataDir, 'server-update-guard.json'), 0o644)
    this.releases.select(releaseId(manifest))
    await this.supervisor.start(this.releases.directory(releaseId(manifest)), jobId)
  }
  private async waitReady(): Promise<void> {
    const end = Date.now() + (this.options.readyTimeoutMs ?? 90000)
    while (Date.now() < end) {
      if (!this.supervisor.running) throw new Error('业务进程启动失败')
      try {
        const response = await requestBusiness(new URL('/ready', this.config.serverUrl), this.config.healthHost)
        if (response.ok) return
      } catch { /* Wait for the real worker and HTTP listener. */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('服务端启动验证超时')
  }
  async startCurrent(): Promise<void> {
    const release = this.releases.current()
    if (!release) throw new Error('当前发行记录缺失')
    await this.releases.verifyInstalled(release)
    if (!this.supervisor.running) await this.supervisor.start(this.releases.directory(release))
    await this.waitReady()
    this.supervisor.allowRestart()
  }
  async verify(manifest: ServerUpdateManifest, original: DeploymentSnapshot): Promise<void> {
    await this.waitReady()
    const checked = await this.inspect()
    if (checked.release !== releaseId(manifest) || checked.identity.version !== manifest.version || checked.identity.schema !== manifest.targetSchema || checked.identity.serverId !== original.identity.serverId || checked.identity.catalogId !== original.identity.catalogId) throw new Error('新版本、schema 或资料库身份验证失败')
  }
  async activate(jobId: string, manifest: ServerUpdateManifest, original: DeploymentSnapshot): Promise<void> {
    const release = releaseId(manifest)
    if (this.releases.current() !== release) throw new Error('已提交发行目录不一致，需要人工恢复')
    await this.validateOriginal(original)
    const before = await this.inspect()
    if (before.identity.schema !== manifest.targetSchema || before.identity.serverId !== original.identity.serverId || before.identity.catalogId !== original.identity.catalogId) throw new Error('已提交资料库身份或 schema 已变化，拒绝开放业务')
    if (!this.supervisor.running) await this.supervisor.start(this.releases.directory(release), jobId)
    await this.verify(manifest, original)
    writeJsonAtomic(path.join(this.config.dataDir, 'server-update-guard.json'), { id: jobId, phase: 'active' })
    fs.chmodSync(path.join(this.config.dataDir, 'server-update-guard.json'), 0o644)
    const end = Date.now() + (this.options.readyTimeoutMs ?? 60000)
    while (Date.now() < end) {
      try {
        const response = await requestBusiness(new URL('/manage/v1/handshake.get', this.config.serverUrl), this.config.healthHost, { body: JSON.stringify({ input: {} }) })
        if (response.ok) {
          const hello = JSON.parse(response.body) as { appVersion: string; schemaVersion: number; identity: { serverId: string; catalogId: string } }
          const checked = await this.inspect()
          if (hello.appVersion === manifest.version && hello.schemaVersion === manifest.targetSchema && hello.identity.serverId === checked.identity.serverId && hello.identity.catalogId === checked.identity.catalogId) { this.supervisor.allowRestart(); return }
        }
      } catch { /* Business access is released only after runtime recovery. */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('新版本已提交，业务开放状态需人工核对')
  }
  async restore(jobDir: string, original: DeploymentSnapshot): Promise<void> {
    await this.validateOriginal(original)
    await this.stop()
    const raw = readJsonIfExists(path.join(jobDir, 'snapshot-complete.json'))
    if (raw) {
      const snapshot = snapshotSchema.parse(raw)
      if (snapshot.release !== original.release || snapshot.configHash !== original.configHash || JSON.stringify(snapshot.roots) !== JSON.stringify(original.roots) || snapshot.hashes.length !== original.roots.length) throw new Error('快照记录与原资料库不一致')
      if (await fileHash(path.join(jobDir, 'snapshot', 'server-config.json')) !== original.configHash) throw new Error('快照配置损坏，停止恢复以保留现场')
      for (let i = 0; i < original.roots.length; i++) if (await treeHash(path.join(jobDir, 'snapshot', `root-${i}`)) !== snapshot.hashes[i]) throw new Error('快照内容损坏，停止恢复以保留现场')
      // Validate all destinations before replacing the first root.
      for (const root of original.roots) await treeBytes(root, { excludeRootLock: root === this.config.dataDir })
      for (let i = 0; i < original.roots.length; i++) await restoreTree(path.join(jobDir, 'snapshot', `root-${i}`), original.roots[i], { excludeRootLock: original.roots[i] === this.config.dataDir })
    } else if (this.releases.current() !== original.release) throw new Error('切换后缺少完整快照，需要人工恢复')
    this.releases.select(original.release)
    await this.startCurrent()
    const checked = await this.inspect()
    if (checked.identity.version !== original.identity.version || checked.identity.schema !== original.identity.schema || checked.identity.serverId !== original.identity.serverId || checked.identity.catalogId !== original.identity.catalogId) throw new Error('原版本恢复验证失败')
  }
}
