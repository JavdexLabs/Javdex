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

export function createRemoteDesktopCapabilities(options: { frozen?: boolean } = {}): DesktopCapabilityMap {
  const frozen = options.frozen === true
  const desktopTools = new Set([
    'runPlugins',
    'runAgents',
    'cropAvatars',
    'openExternalLink',
    'playRemoteFile',
    'editCatalog'
  ])
  return Object.fromEntries(
    DESKTOP_CAPABILITY_ACTIONS.map((action) => {
      if (action === 'editCatalog') {
        return [action, capability(action, !frozen, frozen ? 'catalogFrozen' : 'available')]
      }
      if (desktopTools.has(action)) {
        return [action, capability(action, true, 'available')]
      }
      if (
        action === 'revealLocalFile' ||
        action === 'pickLocalFolder' ||
        action === 'rebindLocalRoot' ||
        action === 'encryptAssets' ||
        action === 'relocateAssetStorage' ||
        action === 'playLocalFile'
      ) {
        return [action, capability(action, false, 'remoteMode')]
      }
      return [action, capability(action, false, 'unsupportedOnServer')]
    })
  ) as DesktopCapabilityMap
}
