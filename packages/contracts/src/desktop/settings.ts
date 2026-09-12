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

export interface CurrentCatalogSettingsView {
  overviewStats: unknown
  browserAccessEnabled: boolean
}
