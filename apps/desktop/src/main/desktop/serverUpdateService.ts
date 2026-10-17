import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { app, safeStorage, dialog } from 'electron'
import { readTestUserDataPath } from '@shared/appIdentity'
import { ServerUpdateClient, uploadServerUpdateBundle } from '@http/updateClient'
import { queryServerEnvironment } from '@http/serverEnvironmentClient'
import { SERVER_ENVIRONMENT_VERSION, type ServerEnvironmentSnapshot } from '@shared/serverEnvironment'
import { updaterPairingSchema, type ServerUpdateCommand, type ServerUpdateSnapshot } from '@shared/serverUpdateTypes'
import { createPinnedFetch } from '@http/pinnedFetch'
import { createWriterCredentialStore } from './writerCredentialStore'
import { assertConnectionStorage, createServerConnectionStore } from './serverConnectionStore'
import { createServerCertificateTrust } from './serverCertificateTrust'
import { assertRemoteBaseUrl } from './remoteConnectionUrl'
import type { DesktopSettingsStore } from '../application/desktopPorts'
import type { CatalogBackend } from '../application/catalogBackend'
import type { IpcContext } from '../ipc/shared'

const empty: ServerUpdateSnapshot = { protocolVersion: 1, paired: false, serverId: null, catalogId: null, currentVersion: null, platform: null, targetVersion: null, job: null }

export function createServerUpdateService(backend: CatalogBackend, ctx: IpcContext, settings: DesktopSettingsStore,
  options: { queryEnvironment?: typeof queryServerEnvironment } = {}): (command: ServerUpdateCommand) => Promise<ServerUpdateSnapshot> {
  const root = readTestUserDataPath() ?? app.getPath('userData')
  const connectionStore = createServerConnectionStore(root)
  let connectionRestartRequired = false
  const connectionStatus = (): ServerUpdateSnapshot => {
    const saved = connectionStore.read()
    const connection = saved?.credentialKind === 'device' ? {
      remoteBaseUrl: saved.remoteBaseUrl, serverId: saved.pairing.serverId, catalogId: saved.pairing.catalogId
    } : null
    return { ...empty, paired: connection !== null, connection, connectionRestartRequired }
  }
  let transferBusy = false
  let connecting = false
  const inspectEnvironment = async (): Promise<ServerEnvironmentSnapshot> => {
    const session = backend.session()
    const unavailable = (message: string): ServerEnvironmentSnapshot => ({ state: 'unavailable', currentVersion: null,
      requiredVersion: SERVER_ENVIRONMENT_VERSION, runtimeId: null, platform: null, message })
    if (session.mode !== 'remote' || !session.remoteBaseUrl) return unavailable('请先选择远程资料库')
    if (session.legacyHttpUpgradeRequired && session.appVersion === '0.8.0') return {
      state: 'imageRequired', currentVersion: null, requiredVersion: SERVER_ENVIRONMENT_VERSION,
      runtimeId: null, platform: null, message: '服务端仍为 0.8.0，请先升级服务端 Docker 镜像；重新检测后将自动迁移至 HTTPS 并保留原授权。'
    }
    assertRemoteBaseUrl(session.remoteBaseUrl)
    const result = await (options.queryEnvironment ?? queryServerEnvironment)(session.remoteBaseUrl, createServerCertificateTrust(root, session.remoteBaseUrl))
    const current = backend.session()
    if (current.mode !== session.mode || current.remoteBaseUrl !== session.remoteBaseUrl || current.serverId !== session.serverId || current.catalogId !== session.catalogId || current.generation !== session.generation) {
      return unavailable('资料库连接已变化，请重新检测运行环境')
    }
    if (result.state === 'imageRequired' && result.currentVersion === null && !session.serverId && !session.appVersion) {
      return unavailable('尚未确认此地址是Javdex服务端，请检查连接地址后重新检测')
    }
    return result
  }
  const load = (): ServerUpdateClient | null => {
    const saved = connectionStore.read()
    if (!saved) return null
    const paired = saved.pairing
    const session = backend.session()
    if (saved.credentialKind === 'device' && session.state === 'available' && session.serverId === paired.serverId && session.catalogId && paired.catalogId !== session.catalogId && session.remoteBaseUrl === saved.remoteBaseUrl) {
      paired.catalogId = session.catalogId
      connectionStore.write(paired)
    }
    if (session.mode !== 'remote' || session.remoteBaseUrl !== saved.remoteBaseUrl || (session.serverId && paired.serverId !== session.serverId) || (session.catalogId && paired.catalogId !== session.catalogId)) throw new Error('已保存的连接不属于当前服务端，请核对资料库连接')
    return new ServerUpdateClient(paired, createServerCertificateTrust(root, paired.url))
  }
  const pick = async (title: string, extensions: string[]): Promise<string | null> => {
    const options = { title, properties: ['openFile' as const], filters: [{ name: '官方更新文件', extensions }] }
    const window = ctx.getWindow()
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0] ?? null
  }
  return async command => {
    if (connecting) throw new Error('服务端配对正在处理')
    if (command.action === 'environment') {
      const environment = await inspectEnvironment()
      const session = backend.session()
      return { ...empty, ...connectionStatus(), serverId: session.serverId ?? null, catalogId: session.catalogId ?? null,
        currentVersion: session.appVersion ?? null, environment }
    }
    if (command.action === 'connectionStatus') return connectionStatus()
    if (command.action === 'forgetConnection') {
      if (transferBusy) throw new Error('更新包正在传输，请完成后取消配对')
      connecting = true
      try {
        await connectionStore.forget(createWriterCredentialStore({ userDataPath: root }))
        connectionRestartRequired = true
        return { ...empty, connection: null, connectionRestartRequired }
      } finally { connecting = false }
    }
    if (command.action === 'devices' || command.action === 'revokeDevice') {
      if (!backend.devices || backend.mode !== 'remote') throw new Error('请先连接远程资料库')
      const devices = command.action === 'devices' ? await backend.devices.list() : await backend.devices.revoke(command.deviceId)
      return { ...empty, devices }
    }
    if (command.action === 'connect') {
      if (transferBusy) throw new Error('更新包正在传输')
      assertConnectionStorage()
      assertRemoteBaseUrl(command.remoteBaseUrl)
      const remoteBaseUrl = new URL(command.remoteBaseUrl).origin
      const pendingFile = path.join(root, 'server-connection-pending.bin')
      const saveSecret = (destination: string, value: unknown): void => {
        fs.mkdirSync(root, { recursive: true })
        const temporary = `${destination}.tmp`
        fs.writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 })
        fs.renameSync(temporary, destination)
      }
      let pending: { remoteBaseUrl: string; oneTimeToken: string; claimId: string; secret: string } | null = fs.existsSync(pendingFile)
        ? JSON.parse(safeStorage.decryptString(fs.readFileSync(pendingFile))) : null
      if (!pending || pending.remoteBaseUrl !== remoteBaseUrl || pending.oneTimeToken !== command.oneTimeToken) {
        pending = { remoteBaseUrl, oneTimeToken: command.oneTimeToken, claimId: randomUUID(), secret: randomBytes(32).toString('hex') }
        saveSecret(pendingFile, pending)
      }
      connecting = true
      let certificateSha256: string | undefined
      const verify = createServerCertificateTrust(root, remoteBaseUrl)
      const transport = createPinnedFetch(remoteBaseUrl, undefined, { verifyCertificate: async (fingerprint, publiclyTrusted) => { await verify(fingerprint, publiclyTrusted); certificateSha256 = fingerprint } })
      try {
        const response = await transport.fetch(new URL('/connect/v1/claim', remoteBaseUrl), { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: command.oneTimeToken, claimId: pending.claimId, secretDigest: createHash('sha256').update(pending.secret).digest('hex'), name: hostname().slice(0, 80) || '管理电脑', appVersion: app.getVersion() }),
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
        if (paired.certificateSha256 !== certificateSha256 || new URL(paired.url).origin !== remoteBaseUrl) throw new Error('服务端连接身份不一致')
        await createWriterCredentialStore({ userDataPath: root }).writeWriterSecret(paired.catalogId, pending.secret)
        connectionStore.write(paired)
        await settings.write({ mode: 'remote', remoteBaseUrl })
        fs.unlinkSync(pendingFile)
        connectionRestartRequired = true
        return { ...empty, paired: true, serverId: paired.serverId, catalogId: paired.catalogId,
          connection: { remoteBaseUrl, serverId: paired.serverId, catalogId: paired.catalogId }, connectionRestartRequired }
      } finally { connecting = false; await transport.close() }
    }
    // Never open a file picker, download bytes or send an update command based
    // only on a renderer's cached success. Read the actual image again first.
    if (command.action !== 'status') {
      const environment = await inspectEnvironment()
      if (environment.state !== 'compatible') throw new Error(environment.message ?? '无法确认服务端运行环境，请重新检测')
    }
    const client = load()
    if (!client) {
      if (command.action === 'status') return { ...empty }
      throw new Error('请先在资料库连接中完成服务端配对')
    }
    if ('targetVersion' in command && command.targetVersion !== backend.session().desktopAppVersion) throw new Error('升级目标必须与当前客户端版本一致')
    if (command.action !== 'import') return {
      ...await client.control(command.action, command.action === 'install' ? command.jobId : undefined, {
        ...('targetVersion' in command ? { targetVersion: command.targetVersion } : {})
      }),
      connection: connectionStatus().connection
    }
    if (transferBusy) throw new Error('更新包正在传输')
    transferBusy = true
    try {
      const bundlePath = await pick('选择官方服务端升级包', ['javdex-update'])
      if (!bundlePath) return { ...await client.control('status'), connection: connectionStatus().connection }
      const fd = fs.openSync(bundlePath, 'r')
      try {
        return { ...await uploadServerUpdateBundle(client, fd, command.targetVersion), connection: connectionStatus().connection }
      } finally { fs.closeSync(fd) }
    } finally { transferBusy = false }
  }
}
