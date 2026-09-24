import { structuredError } from '@shared/protocol/errors'
import type { WebDevice } from '@shared/webTypes'

export interface ManageBrowserStatus {
  enabled: boolean
  running: boolean
  port: number
  username: string
  hasPassword: boolean
  urls: string[]
  devices: WebDevice[]
  pairingUntil: number
  pairingActivity: { code: string; name: string; state: 'approved' | 'connected' }[]
  sessions: number
  error: string | null
}

export interface ManageBrowserSurface {
  status(): ManageBrowserStatus
  setEnabled(enabled: boolean): ManageBrowserStatus
  pairOpen(): ManageBrowserStatus
  pairInspect(code: string): { name: string; expires: number; remember: boolean }
  pairDecide(code: string, approve: boolean): ManageBrowserStatus
  deviceRemove(id: string): ManageBrowserStatus
  deviceRename(id: string, name: string): ManageBrowserStatus
  deviceReset(id: string): ManageBrowserStatus
  revokeSessions(): ManageBrowserStatus
}

let surface: ManageBrowserSurface | null = null

export function setManageBrowserSurface(next: ManageBrowserSurface | null): void {
  surface = next
}

export function readManageBrowserEnabled(): boolean {
  return surface?.status().enabled !== false
}

export function requireManageBrowserSurface(): ManageBrowserSurface {
  if (!surface) {
    throw structuredError('UNSUPPORTED_CAPABILITY', '浏览配对宿主未装配')
  }
  return surface
}
