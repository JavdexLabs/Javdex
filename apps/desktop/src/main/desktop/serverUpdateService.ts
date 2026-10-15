import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { app, safeStorage, dialog } from 'electron'
import { readTestUserDataPath } from '@shared/appIdentity'
import { ServerUpdateClient, uploadServerUpdateBundle } from '@http/updateClient'
import { updaterPairingSchema, serverConnectionBundleSchema, type ServerUpdateCommand, type ServerUpdateSnapshot } from '@shared/serverUpdateTypes'
import { createPinnedFetch } from '@http/pinnedFetch'
import { createWriterCredentialStore } from './writerCredentialStore'
import { assertConnectionStorage } from './serverConnectionStore'
import type { DesktopSettingsStore } from '../application/desktopPorts'
import type { CatalogBackend } from '../application/catalogBackend'
import type { IpcContext } from '../ipc/shared'

const empty: ServerUpdateSnapshot = { protocolVersion: 1, paired: false, serverId: null, catalogId: null, currentVersion: null, platform: null, targetVersion: null, job: null }

export function createServerUpdateService(backend: CatalogBackend, ctx: IpcContext, settings: DesktopSettingsStore): (command: ServerUpdateCommand) => Promise<ServerUpdateSnapshot> {
  const root = readTestUserDataPath() ?? app.getPath('userData')
  const file = path.join(root, 'server-update-secrets.bin')
  let transferBusy = false
  let connecting = false
  const secureStorage = (): boolean => safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
  const load = (): ServerUpdateClient | null => {
    if (!fs.existsSync(file)) return null
    if (!secureStorage()) throw new Error('安全凭据存储不可用')
    const saved = JSON.parse(safeStorage.decryptString(fs.readFileSync(file))) as { pairing: unknown; remoteBaseUrl: string; credentialKind?: 'device' }
    const paired = updaterPairingSchema.parse(saved.pairing)
    const session = backend.session()
    if (saved.credentialKind === 'device' && session.state === 'available' && session.serverId === paired.serverId && session.catalogId && paired.catalogId !== session.catalogId && session.remoteBaseUrl === saved.remoteBaseUrl) {
      paired.catalogId = session.catalogId
      const temporary = `${file}.tmp`
      fs.writeFileSync(temporary, safeStorage.encryptString(JSON.stringify({ ...saved, pairing: paired })), { mode: 0o600 })
      fs.renameSync(temporary, file)
    }
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
    if (connecting) throw new Error('服务端配对正在处理')
    if (command.action === 'devices' || command.action === 'revokeDevice') {
      if (!backend.devices || backend.mode !== 'remote') throw new Error('请先连接远程资料库')
      const devices = command.action === 'devices' ? await backend.devices.list() : await backend.devices.revoke(command.deviceId)
      return { ...empty, devices }
    }
    if (command.action === 'connect') {
      if (transferBusy) throw new Error('更新包正在传输')
      assertConnectionStorage()
      const bundle = serverConnectionBundleSchema.parse(JSON.parse(command.pairing))
      const pendingFile = path.join(root, 'server-connection-pending.bin')
      const saveSecret = (destination: string, value: unknown): void => {
        fs.mkdirSync(root, { recursive: true })
        const temporary = `${destination}.tmp`
        fs.writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 })
        fs.renameSync(temporary, destination)
      }
      let pending: { bundle: typeof bundle; claimId: string; secret: string } | null = fs.existsSync(pendingFile)
        ? JSON.parse(safeStorage.decryptString(fs.readFileSync(pendingFile))) : null
      if (!pending || JSON.stringify(pending.bundle) !== JSON.stringify(bundle)) {
        pending = { bundle, claimId: randomUUID(), secret: randomBytes(32).toString('hex') }
        saveSecret(pendingFile, pending)
      }
      connecting = true
      const transport = createPinnedFetch(bundle.url, bundle.certificateSha256)
      try {
        const response = await transport.fetch(new URL('/connect/v1/claim', bundle.url), { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: bundle.code, claimId: pending.claimId, secretDigest: createHash('sha256').update(pending.secret).digest('hex'), name: hostname().slice(0, 80) || '管理电脑', appVersion: app.getVersion() }),
          signal: AbortSignal.timeout(20_000) })
        const reader = response.body?.getReader()
        if (!reader) throw new Error('服务端未返回配对信息')
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 65_536) throw new Error('服务端配对响应过大')
            chunks.push(value)
          }
        } finally { await reader.cancel(); reader.releaseLock() }
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: string }
        if (!response.ok) throw new Error(result.error ?? '服务端配对失败')
        const paired = updaterPairingSchema.parse({ ...result, token: pending.secret })
        if (paired.serverId !== bundle.serverId || paired.catalogId !== bundle.catalogId || paired.certificateSha256 !== bundle.certificateSha256 || new URL(paired.url).origin !== new URL(bundle.url).origin) throw new Error('服务端配对身份不一致')
        await createWriterCredentialStore({ userDataPath: root }).writeWriterSecret(bundle.catalogId, pending.secret)
        saveSecret(file, { pairing: paired, remoteBaseUrl: new URL(bundle.url).origin, credentialKind: 'device' })
        await settings.write({ mode: 'remote', remoteBaseUrl: new URL(bundle.url).origin })
        fs.unlinkSync(pendingFile)
        return { ...empty, paired: true, serverId: paired.serverId, catalogId: paired.catalogId }
      } finally { connecting = false; await transport.close() }
    }
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
      const bundlePath = await pick('选择官方服务端升级包', ['javdex-update'])
      if (!bundlePath) return client.control('status')
      const fd = fs.openSync(bundlePath, 'r')
      try {
        return await uploadServerUpdateBundle(client, fd)
      } finally { fs.closeSync(fd) }
    } finally { transferBusy = false }
  }
}
