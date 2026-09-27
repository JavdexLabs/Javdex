export type DesktopSettingsScope = 'thisComputer' | 'currentCatalog'

export interface ThisComputerSettings {
  mode: 'local' | 'remote'
  remoteBaseUrl: string | null
  closeToTray: boolean
  theme: string
  playerPath: string | null
  proxyUrl: string
  proxyUrlEnabled: boolean
  llmProxyUrl: string
  llmProxyUrlEnabled: boolean
}

export interface ThisComputerSettingsPatch {
  mode?: 'local' | 'remote'
  remoteBaseUrl?: string | null
  playerPath?: string | null
}

export interface ThisComputerSettingsUpdateResult {
  settings: ThisComputerSettings
  restartRequired: boolean
}

export type DefaultPlayerDetectionResult =
  | { status: 'found'; path: string; extension: string }
  | { status: 'unavailable'; message: string }

export interface RemoteConnectionProbeResult {
  status: 'reachable' | 'notBound' | 'versionMismatch' | 'notReady' | 'unavailable'
  message: string
  serverVersion: string | null
  serverId: string | null
  catalogId: string | null
}

export interface CurrentCatalogSettingsView {
  overviewStats: unknown
  browserAccessEnabled: boolean
}
