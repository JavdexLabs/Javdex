import { app, dialog, type OpenDialogOptions } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { IPC } from '@shared/ipc-channels'
import { structuredError, isStructuredError } from '@shared/protocol/errors'
import type { DesktopSessionSnapshot } from '@shared/desktop/session'
import type { RemoteConnectionProbeResult, ThisComputerSettingsPatch } from '@shared/desktop/settings'
import type { HandshakeResult } from '@shared/protocol/handshake'
import { ManageHttpClient } from '@http/manageClient'
import type { CatalogBackend } from '../application/catalogBackend'
import type { DesktopSettingsStore } from '../application/desktopPorts'
import { appCommandAdapter, appEventAdapter } from './appContractAdapter'
import type { IpcContext } from './shared'
import { detectDefaultPlayer } from '../desktop/defaultPlayerService'

export interface DesktopSessionHandlerPorts {
  backend: CatalogBackend
  settings: DesktopSettingsStore
}

function snapshot(backend: CatalogBackend): DesktopSessionSnapshot {
  return {
    session: backend.session(),
    capabilities: backend.capabilities()
  }
}

function assertRemoteBaseUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw structuredError('INVALID_INPUT', '请输入完整的 HTTP / HTTPS 服务器地址')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw structuredError('INVALID_INPUT', '远程地址只支持 HTTP 或 HTTPS')
  }
  if (parsed.username || parsed.password) {
    throw structuredError('INVALID_INPUT', '远程地址不能包含用户名或密码')
  }
}

export async function probeRemoteConnection(baseUrl: string, appVersion: string): Promise<RemoteConnectionProbeResult> {
  const url = baseUrl.trim()
  assertRemoteBaseUrl(url)
  try {
    const hello = await new ManageHttpClient({ baseUrl: url, appVersion, timeoutMs: 5_000 })
      .post('handshake.get', { input: {} }, { sendAppVersion: false }) as HandshakeResult
    if (!hello || typeof hello.appVersion !== 'string' ||
        typeof hello.identity?.serverId !== 'string' || typeof hello.identity.catalogId !== 'string' ||
        typeof hello.writerEpoch !== 'number' || typeof hello.ready !== 'string') {
      return { status: 'unavailable', message: '服务器未返回有效的 Javdex 连接信息', serverVersion: null, serverId: null, catalogId: null }
    }
    const identity = {
      serverVersion: hello.appVersion,
      serverId: hello.identity.serverId,
      catalogId: hello.identity.catalogId
    }
    if (hello.appVersion !== appVersion) {
      return { status: 'versionMismatch', message: `版本不一致：桌面 ${appVersion}，服务端 ${hello.appVersion}`, ...identity }
    }
    if (hello.ready === 'notBound' || hello.writerEpoch === 0) {
      return { status: 'notBound', message: '服务可达，尚未领取写入凭据；重启切换后完成首次授权', ...identity }
    }
    if (hello.ready !== 'ready') {
      return { status: 'notReady', message: `服务可达，但资料库当前状态为 ${hello.ready}，暂不可写入`, ...identity }
    }
    return { status: 'reachable', message: '服务可达且版本匹配；重启切换后检查这台电脑的写入授权', ...identity }
  } catch (reason) {
    return {
      status: 'unavailable',
      message: isStructuredError(reason) ? reason.message : '无法连接服务器，请检查地址、端口与服务状态',
      serverVersion: null, serverId: null, catalogId: null
    }
  }
}

async function pickPlayerProgram(ctx: IpcContext, currentPath: string | null): Promise<string | null> {
  const defaultPath =
    currentPath && path.isAbsolute(currentPath) && fs.existsSync(currentPath)
      ? currentPath
      : process.platform === 'darwin'
        ? '/Applications'
        : process.platform === 'win32'
          ? process.env.ProgramFiles
          : '/usr/bin'
  const options: OpenDialogOptions = {
    title: '选择播放器程序',
    buttonLabel: '选择程序',
    defaultPath,
    properties: ['openFile'],
    ...(process.platform === 'win32'
      ? { filters: [{ name: '应用程序', extensions: ['exe'] }] }
      : {})
  }
  const window = ctx.getWindow()
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) return null

  const selected = result.filePaths[0]
  let stat: fs.Stats
  try {
    stat = fs.statSync(selected)
  } catch {
    throw structuredError('INVALID_INPUT', '所选程序已不存在，请重新选择')
  }
  if (process.platform === 'darwin' && selected.toLowerCase().endsWith('.app') && stat.isDirectory()) {
    return selected
  }
  if (!stat.isFile() || (process.platform === 'win32' && !selected.toLowerCase().endsWith('.exe'))) {
    throw structuredError('INVALID_INPUT', '请选择播放器的可执行程序')
  }
  if (process.platform !== 'win32') {
    try {
      fs.accessSync(selected, fs.constants.X_OK)
    } catch {
      throw structuredError('INVALID_INPUT', '所选文件没有执行权限，请选择播放器程序')
    }
  }
  return selected
}

export function registerDesktopSessionHandlers(
  ctx: IpcContext,
  ports: DesktopSessionHandlerPorts,
  adapter: typeof appCommandAdapter = appCommandAdapter,
  pickPlayer: (currentPath: string | null) => Promise<string | null> = (currentPath) =>
    pickPlayerProgram(ctx, currentPath),
  actions: {
    probe: (baseUrl: string) => Promise<RemoteConnectionProbeResult>
    restart: () => void
  } = {
    probe: (baseUrl) => probeRemoteConnection(baseUrl, app.getVersion()),
    restart: () => { app.relaunch(); setTimeout(() => app.quit(), 0) }
  }
): void {
  const publish = (): DesktopSessionSnapshot => {
    const next = snapshot(ports.backend)
    appEventAdapter.send(ctx.getWindow()?.webContents, IPC.DESKTOP_SESSION_CHANGED, next)
    return next
  }
  ports.backend.onSessionChanged?.(publish)

  adapter.register(IPC.DESKTOP_SESSION_GET, () => snapshot(ports.backend))

  adapter.register(IPC.DESKTOP_RECONNECT, async () => {
    await ports.backend.reconnect()
    return publish()
  })

  adapter.register(IPC.THIS_COMPUTER_GET, () => ports.settings.read())

  adapter.register(IPC.THIS_COMPUTER_PICK_PLAYER, (currentPath) => pickPlayer(currentPath))
  adapter.register(IPC.THIS_COMPUTER_DETECT_PLAYER, () => detectDefaultPlayer())

  adapter.register(IPC.THIS_COMPUTER_PROBE, (baseUrl) => actions.probe(baseUrl))

  adapter.register(IPC.THIS_COMPUTER_RESTART, () => actions.restart())

  adapter.register(IPC.THIS_COMPUTER_UPDATE, async (patch: ThisComputerSettingsPatch) => {
    const current = await ports.settings.read()
    const mode = patch.mode ?? current.mode
    const remoteBaseUrl =
      patch.remoteBaseUrl !== undefined ? patch.remoteBaseUrl : current.remoteBaseUrl
    if (mode === 'remote') {
      if (!remoteBaseUrl || !remoteBaseUrl.trim()) {
        throw structuredError('INVALID_INPUT', '远程模式需要服务器地址')
      }
      assertRemoteBaseUrl(remoteBaseUrl.trim())
    }
    const settings = await ports.settings.write(patch)
    const restartRequired =
      settings.mode !== current.mode || settings.remoteBaseUrl !== current.remoteBaseUrl
    return { settings, restartRequired }
  })

  adapter.register(IPC.WRITER_CLAIM, async (input) => {
    const result = await ports.backend.claimWriter(input)
    publish()
    return result
  })
}
