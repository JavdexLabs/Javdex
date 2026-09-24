import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

interface IpcSecurityConfig {
  getWindow: () => BrowserWindow | null
  isTrustedUrl: (url: string) => boolean
}

let securityConfig: IpcSecurityConfig | null = null

export function configureIpcSecurity(config: IpcSecurityConfig): void {
  securityConfig = config
}

export function resetIpcSecurityForTests(): void {
  securityConfig = null
}

export function isSameRendererLocation(candidate: string, expected: string): boolean {
  try {
    const candidateUrl = new URL(candidate)
    const expectedUrl = new URL(expected)

    if (expectedUrl.protocol === 'file:') {
      return (
        candidateUrl.protocol === 'file:' &&
        candidateUrl.host === expectedUrl.host &&
        candidateUrl.pathname === expectedUrl.pathname
      )
    }

    return candidateUrl.origin === expectedUrl.origin
  } catch {
    return false
  }
}

export function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  const config = securityConfig
  if (!config) throw new Error('IPC 安全策略尚未初始化')

  const window = config.getWindow()
  if (!window || window.isDestroyed() || event.sender !== window.webContents) {
    throw new Error('已拒绝非主窗口的 IPC 请求')
  }

  const senderFrame = event.senderFrame
  if (!senderFrame || senderFrame !== event.sender.mainFrame) {
    throw new Error('已拒绝非主页面的 IPC 请求')
  }

  if (!config.isTrustedUrl(senderFrame.url)) {
    throw new Error('已拒绝来自非受信页面的 IPC 请求')
  }
}
