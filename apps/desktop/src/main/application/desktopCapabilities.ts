import type { DesktopCapability, DesktopCapabilityMap } from '@shared/desktop/capabilities'
import { DESKTOP_CAPABILITY_ACTIONS } from '@shared/desktop/capabilities'

function capability(
  action: DesktopCapability['action'],
  allowed: boolean,
  reason: DesktopCapability['reason']
): DesktopCapability {
  return { action, allowed, reason: allowed ? 'available' : reason }
}

export function createLocalDesktopCapabilities(): DesktopCapabilityMap {
  const localOnly = new Set([
    'revealLocalFile',
    'pickLocalFolder',
    'rebindLocalRoot',
    'encryptAssets',
    'relocateAssetStorage',
    'runPlugins',
    'runAgents',
    'cropAvatars',
    'playLocalFile',
    'openExternalLink',
    'manageBrowserPairing',
    'editCatalog',
    'migrateCatalog'
  ])
  return Object.fromEntries(
    DESKTOP_CAPABILITY_ACTIONS.map((action) => [
      action,
      capability(action, localOnly.has(action), action === 'playRemoteFile' ? 'localMode' : 'localMode')
    ])
  ) as DesktopCapabilityMap
}

export function createUnconfiguredRemoteCapabilities(): DesktopCapabilityMap {
  return Object.fromEntries(
    DESKTOP_CAPABILITY_ACTIONS.map((action) => {
      const localOnly =
        action === 'revealLocalFile' ||
        action === 'pickLocalFolder' ||
        action === 'rebindLocalRoot' ||
        action === 'encryptAssets' ||
        action === 'relocateAssetStorage' ||
        action === 'playLocalFile'
      return [
        action,
        capability(action, false, localOnly ? 'remoteMode' : 'needsLocalPrep')
      ]
    })
  ) as DesktopCapabilityMap
}
