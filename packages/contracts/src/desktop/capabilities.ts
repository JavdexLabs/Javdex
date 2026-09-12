export type DesktopCapabilityReason =
  | 'available'
  | 'remoteMode'
  | 'localMode'
  | 'offlineRoot'
  | 'readOnlyMount'
  | 'writerRevoked'
  | 'catalogFrozen'
  | 'unsupportedOnServer'
  | 'needsLocalPrep'
  | 'playerMissing'

export interface DesktopCapability {
  action: string
  allowed: boolean
  reason: DesktopCapabilityReason
}

export const DESKTOP_CAPABILITY_ACTIONS = [
  'revealLocalFile',
  'pickLocalFolder',
  'rebindLocalRoot',
  'encryptAssets',
  'relocateAssetStorage',
  'runPlugins',
  'runAgents',
  'cropAvatars',
  'playRemoteFile',
  'playLocalFile',
  'openExternalLink',
  'manageBrowserPairing',
  'editCatalog',
  'migrateCatalog'
] as const

export type DesktopCapabilityAction = (typeof DESKTOP_CAPABILITY_ACTIONS)[number]

export type DesktopCapabilityMap = Record<DesktopCapabilityAction, DesktopCapability>
