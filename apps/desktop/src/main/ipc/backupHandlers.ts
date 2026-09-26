import { app, dialog, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/ipc-channels'
import { BACKUP_CHUNK_BYTES, type BackupJob } from '@shared/protocol/backup'
import { sha256File } from '@library/catalog/catalogMigrationArchive'
import { resolveLibraryUserDataPath } from '@library/runtime/host'
import { resolveMediaAssetsRoot } from '@library/assetStoragePaths'
import type { CatalogBackend } from '../application/catalogBackend'
import { appCommandAdapter, appEventAdapter } from './appContractAdapter'
import type { IpcContext } from './shared'

interface Transfer { id: string; downloaded?: number; source?: string; destination?: string; savedPath?: string; error?: string; serverId: string | null; baseUrl: string | null }
export function registerBackupHandlers(ctx: IpcContext, backend: CatalogBackend, adapter = appCommandAdapter,
  createWorker = (source: { id: string; userDataPath: string; imagesDir: string }): Worker =>
    new Worker(path.join(app.getAppPath(), 'out/main/backupSourceWorker.js'), { execArgv: [], workerData: { ...source, appVersion: app.getVersion() } })): void {
  const transferFile = path.join(resolveLibraryUserDataPath(), 'backup-transfers.json')
  const transfers: Record<string, Transfer> = fs.existsSync(transferFile) ? JSON.parse(fs.readFileSync(transferFile, 'utf8')) as Record<string, Transfer> : {}
  const active = new Set<string>()
  const exports = new Map<string, { worker: Worker; job: BackupJob }>()
  let startingExport = false
  const saveTransfers = (): void => { fs.writeFileSync(`${transferFile}.tmp`, JSON.stringify(transfers), { mode: 0o600 }); fs.renameSync(`${transferFile}.tmp`, transferFile) }
  const belongs = (transfer: Transfer): boolean => transfer.serverId === backend.session().serverId && transfer.baseUrl === (backend.session().remoteBaseUrl ?? null)
  const decorate = (job: BackupJob): BackupJob => ({ ...job, savedPath: transfers[job.id]?.savedPath, transferError: transfers[job.id]?.error, downloadedBytes: transfers[job.id]?.downloaded, downloading: active.has(job.id) && Boolean(transfers[job.id]?.destination) })
  const addTransfer = (id: string, values: Partial<Transfer>): void => {
    transfers[id] = { id, serverId: backend.session().serverId, baseUrl: backend.session().remoteBaseUrl ?? null, ...values }
    saveTransfers()
  }
  async function move(id: string): Promise<void> {
    if (active.has(id)) return
    const transfer = transfers[id]
    if (!transfer || !belongs(transfer)) throw new Error('传输所属的资料库连接已变化')
    active.add(id); transfer.error = undefined; saveTransfers()
    try {
      let job = (await backend.backup.request({ action: 'status', id })).jobs[0]
      if (transfer.source && job.phase === 'receiving') {
        if (fs.statSync(transfer.source).size !== job.bytes || sha256File(transfer.source) !== job.sha256) throw new Error('备份文件已变化，请重新选择')
        const fd = fs.openSync(transfer.source, 'r')
        try {
          while (job.transferred < job.bytes) {
            const data = Buffer.alloc(Math.min(BACKUP_CHUNK_BYTES, job.bytes - job.transferred))
            fs.readSync(fd, data, 0, data.length, job.transferred)
            job.transferred = await backend.backup.upload(id, job.transferred, data)
          }
        } finally { fs.closeSync(fd) }
        await backend.backup.request({ action: 'inspect', id })
      }
      if (transfer.destination) {
        while (!['completed', 'failed', 'cancelled', 'recoveryRequired'].includes(job.phase)) {
          await new Promise(resolve => setTimeout(resolve, 500))
          job = (await backend.backup.request({ action: 'status', id })).jobs[0]
        }
        if (job.phase !== 'completed') throw new Error(job.error ?? '备份没有完成')
        const partial = `${transfer.destination}.${id}.partial`
        let offset = fs.existsSync(partial) ? fs.statSync(partial).size : 0
        const fd = fs.openSync(partial, 'a', 0o600)
        try {
          while (offset < job.bytes) {
            const data = await backend.backup.download(id, offset)
            if (!data.length || offset + data.length > job.bytes) throw new Error('备份下载长度不正确')
            fs.writeSync(fd, data); offset += data.length; transfer.downloaded = offset
          }
          fs.fsyncSync(fd)
        } finally { fs.closeSync(fd) }
        if (sha256File(partial) !== job.sha256) { fs.unlinkSync(partial); transfer.downloaded = 0; throw new Error('下载校验失败，请重试传输') }
        fs.renameSync(partial, transfer.destination)
        transfer.savedPath = transfer.destination
      }
    } catch (error) { transfer.error = error instanceof Error ? error.message : String(error) }
    finally { active.delete(id); saveTransfers() }
  }
  async function receive(file: string, id = randomUUID()): Promise<BackupJob> {
    const result = await backend.backup.request({ action: 'receive', id, bytes: fs.statSync(file).size, sha256: sha256File(file) })
    addTransfer(id, { source: file }); void move(id)
    return result.jobs[0]
  }
  adapter.register(IPC.BACKUP_CONTROL, async input => {
    if (['removeRecord', 'previewRemoval'].includes(input.action) && 'id' in input && active.has(input.id)) throw new Error('备份正在传输，请完成传输后删除记录')
    const local = 'id' in input ? exports.get(input.id) : undefined
    if (local) {
      if (input.action === 'previewRemoval') {
        if (!['failed', 'cancelled'].includes(local.job.phase)) throw new Error('请等待本机导出结束后删除记录')
        return { jobs: [local.job], removal: { digest: '0'.repeat(64), bytes: 0, fileCount: 0,
          location: '', host: 'remote' as const, automaticBackup: false, retainedAutomaticBackup: false,
          blockedReason: '本机导出尚未上传，服务端没有可清理的备份文件。本机导出副本保留。' } }
      }
      if (input.action === 'removeRecord') {
        if (input.deleteFiles) throw new Error('本机导出尚未上传，没有服务端备份可清理')
        if (!['failed', 'cancelled'].includes(local.job.phase)) throw new Error('请等待本机导出结束后删除记录')
        exports.delete(input.id)
        return { jobs: [] }
      }
      if (input.action === 'cancel') {
        if (['failed', 'cancelled'].includes(local.job.phase)) exports.delete(local.job.id)
        else local.worker.postMessage('cancel')
      }
      else if (input.action === 'confirmMissingImages') {
        if (local.job.phase !== 'awaitingImages' || local.job.missingImages?.digest !== input.digest) throw new Error('缺失图片清单已变化，请重新核对')
        local.worker.postMessage(input)
      }
      else if (input.action !== 'status') throw new Error('请等待本机资料导出完成')
      return { jobs: [local.job] }
    }
    const result = await backend.backup.request(input)
    if (input.action === 'removeRecord') { delete transfers[input.id]; saveTransfers() }
    if (input.action === 'list') result.jobs.push(...[...exports.values()].map(entry => entry.job))
    if (result.jobs.some(job => job.newCatalogId && job.phase === 'completed' && job.newCatalogId === backend.session().catalogId)) {
      appEventAdapter.send(ctx.getWindow()?.webContents, IPC.DESKTOP_SESSION_CHANGED, { session: backend.session(), capabilities: backend.capabilities() })
    }
    return { ...result, jobs: result.jobs.map(decorate) }
  })
  adapter.register(IPC.BACKUP_FILE, async input => {
    if (input.action === 'pickDirectory') {
      if (backend.mode !== 'local') throw new Error('服务端目录请使用挂载选择器')
      const result = await dialog.showOpenDialog({ title: '选择资源目录', properties: ['openDirectory'] })
      return { path: result.filePaths[0], cancelled: result.canceled }
    }
    if (input.action === 'reveal') {
      const transfer = transfers[input.id]
      if (!transfer?.savedPath || !belongs(transfer)) throw new Error('没有已保存的本机备份')
      shell.showItemInFolder(transfer.savedPath); return {}
    }
    if (input.action === 'resume') { if (!transfers[input.id] || !belongs(transfers[input.id])) throw new Error('传输所属资料库已变化'); void move(input.id); return {} }
    if (input.action === 'open') {
      const picked = await dialog.showOpenDialog({ title: '选择资料库备份', properties: ['openFile'], filters: [{ name: 'Javdex 资料库备份', extensions: ['javdex-backup'] }] })
      return picked.canceled ? { cancelled: true } : { job: await receive(picked.filePaths[0]) }
    }
    if (input.action === 'importLocal') {
      if (backend.mode !== 'remote' || backend.session().state !== 'available') throw new Error('请先连接并领取服务端写入凭据')
      if (startingExport || [...exports.values()].some(entry => !['failed', 'cancelled'].includes(entry.job.phase))) throw new Error('本机导出已在进行')
      startingExport = true
      try {
        await backend.backup.request({ action: 'list' })
        const id = randomUUID()
        const job: BackupJob = { id, kind: 'restore', phase: 'snapshot', bytes: 0, transferred: 0, createdAt: new Date().toISOString() }
        const worker = createWorker({ id, userDataPath: resolveLibraryUserDataPath(), imagesDir: resolveMediaAssetsRoot() })
        const entry = { worker, job }; exports.set(id, entry)
        let finished = false
        const fail = (error: Error): void => { finished = true; entry.job = { ...entry.job, phase: 'failed', error: error.message } }
        worker.on('message', (message: { job?: BackupJob; file?: string; error?: string }) => {
          if (message.job?.phase === 'cancelled') finished = true
          if (message.job) entry.job = { ...message.job, kind: 'restore', phase: message.job.phase === 'completed' ? 'receiving' : message.job.phase }
          if (message.file) {
            finished = true
            void receive(message.file, id).then(() => exports.delete(id), fail)
          }
          if (message.error) fail(new Error(message.error))
        })
        worker.on('error', fail)
        worker.on('exit', () => { if (!finished) fail(new Error('本机备份进程提前退出')) })
        return { job }
        } finally { startingExport = false }

    }
    const selected = await dialog.showSaveDialog({ title: '保存资料库备份', defaultPath: `Javdex-${new Date().toISOString().slice(0, 10)}.javdex-backup`, filters: [{ name: 'Javdex 资料库备份', extensions: ['javdex-backup'] }] })
    if (selected.canceled || !selected.filePath) return { cancelled: true }
    const id = input.action === 'save' ? input.id : randomUUID()
    const result = await backend.backup.request({ action: input.action === 'save' ? 'status' : 'create', id })
    addTransfer(id, { destination: selected.filePath }); void move(id)
    return { job: result.jobs[0] }
  })
}
