import { IPC } from '@shared/ipc-channels'
import { structuredError } from '@shared/protocol/errors'
import type { DesktopSessionSnapshot } from '@shared/desktop/session'
import type { ThisComputerSettingsPatch } from '@shared/desktop/settings'
import type { CatalogBackend } from '../application/catalogBackend'
import type { DesktopSettingsStore } from '../application/desktopPorts'
import { appCommandAdapter, appEventAdapter } from './appContractAdapter'
import type { IpcContext } from './shared'

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

export function registerDesktopSessionHandlers(
  ctx: IpcContext,
  ports: DesktopSessionHandlerPorts,
  adapter: typeof appCommandAdapter = appCommandAdapter
): void {
  const publish = (): DesktopSessionSnapshot => {
    const next = snapshot(ports.backend)
    appEventAdapter.send(ctx.getWindow()?.webContents, IPC.DESKTOP_SESSION_CHANGED, next)
    return next
  }

  adapter.register(IPC.DESKTOP_SESSION_GET, () => snapshot(ports.backend))

  adapter.register(IPC.DESKTOP_RECONNECT, async () => {
    await ports.backend.reconnect()
    return publish()
  })

  adapter.register(IPC.THIS_COMPUTER_GET, () => ports.settings.read())

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
