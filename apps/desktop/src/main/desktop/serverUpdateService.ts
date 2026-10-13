import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage, dialog } from 'electron'
import { readTestUserDataPath } from '@shared/appIdentity'
import { ServerUpdateClient } from '@http/updateClient'
import { updaterPairingSchema, signedUpdateSchema, type ServerUpdateCommand, type ServerUpdateSnapshot } from '@shared/serverUpdateTypes'
import type { CatalogBackend } from '../application/catalogBackend'
import type { IpcContext } from '../ipc/shared'

const empty: ServerUpdateSnapshot = { protocolVersion: 1, paired: false, serverId: null, catalogId: null, currentVersion: null, platform: null, targetVersion: null, job: null }

export function createServerUpdateService(backend: CatalogBackend, ctx: IpcContext): (command: ServerUpdateCommand) => Promise<ServerUpdateSnapshot> {
  const root = readTestUserDataPath() ?? app.getPath('userData')
  const file = path.join(root, 'server-update-secrets.bin')
  let transferBusy = false
  const secureStorage = (): boolean => safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
  const load = (): ServerUpdateClient | null => {
    if (!fs.existsSync(file)) return null
    if (!secureStorage()) throw new Error('安全凭据存储不可用')
    const saved = JSON.parse(safeStorage.decryptString(fs.readFileSync(file))) as { pairing: unknown; remoteBaseUrl: string }
    const paired = updaterPairingSchema.parse(saved.pairing)
    const session = backend.session()
    if (session.mode !== 'remote' || session.remoteBaseUrl !== saved.remoteBaseUrl || (session.serverId && paired.serverId !== session.serverId) || (session.catalogId && paired.catalogId !== session.catalogId)) throw new Error('更新授权不属于当前服务端，请重新配对')
    return new ServerUpdateClient(paired)
  }
  const pick = async (title: string, extensions: string[]): Promise<string | null> => {
    const options = { title, properties: ['openFile' as const], filters: [{ name: '官方更新文件', extensions }] }
    const window = ctx.getWindow()
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0] ?? null
  }
  return async command => {
    if (command.action === 'forget') {
      if (transferBusy) throw new Error('更新包正在传输，请完成后解除配对')
      if (fs.existsSync(file)) fs.unlinkSync(file)
      return { ...empty }
    }
    if (command.action === 'pair') {
      if (transferBusy) throw new Error('更新包正在传输')
      const paired = updaterPairingSchema.parse(JSON.parse(command.pairing))
      const session = backend.session()
      if (session.mode !== 'remote' || !session.serverId || !session.catalogId || session.serverId !== paired.serverId || session.catalogId !== paired.catalogId) throw new Error('配对信息与当前远程资料库不一致，请先核对连接')
      if (!secureStorage()) throw new Error('安全凭据存储不可用，无法保存更新授权')
      const status = await new ServerUpdateClient(paired).control('status')
      const latest = backend.session()
      if (latest.serverId !== paired.serverId || latest.catalogId !== paired.catalogId || latest.remoteBaseUrl !== session.remoteBaseUrl) throw new Error('配对期间资料库连接已变化，请重新核对')
      fs.mkdirSync(root, { recursive: true })
      const temporary = `${file}.tmp`
      fs.writeFileSync(temporary, safeStorage.encryptString(JSON.stringify({ pairing: paired, remoteBaseUrl: session.remoteBaseUrl })), { mode: 0o600 })
      fs.renameSync(temporary, file)
      return status
    }
    const client = load()
    if (!client) {
      if (command.action === 'status') return { ...empty }
      throw new Error('请先配对服务端更新助手')
    }
    if (command.action !== 'import') return client.control(command.action, command.action === 'install' ? command.jobId : undefined)
    if (transferBusy) throw new Error('更新包正在传输')
    transferBusy = true
    try {
      const manifestPath = await pick('选择官方更新签名清单', ['json'])
      if (!manifestPath) return client.control('status')
      if (fs.statSync(manifestPath).size > 65536) throw new Error('更新清单过大')
      const signed = signedUpdateSchema.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf8')))
      const archivePath = await pick('选择对应的完整服务端发行包', ['gz', 'tar'])
      if (!archivePath) return client.control('status')
      let status = await client.import(signed)
      if (!status.job || fs.statSync(archivePath).size !== status.job.totalBytes) throw new Error('所选发行包大小与官方清单不一致')
      const fd = fs.openSync(archivePath, 'r')
      try {
        while (status.job?.phase === 'preparing' && status.job.receivedBytes < status.job.totalBytes) {
          const offset = status.job.receivedBytes
          const buffer = Buffer.alloc(Math.min(8 * 1024 ** 2, status.job.totalBytes - offset))
          const bytes = fs.readSync(fd, buffer, 0, buffer.length, offset)
          if (bytes !== buffer.length) throw new Error('发行包在上传期间发生变化，请重新选择')
          status = await client.upload(status.job.id, offset, buffer)
        }
      } finally { fs.closeSync(fd) }
      return status
    } finally { transferBusy = false }
  }
}
