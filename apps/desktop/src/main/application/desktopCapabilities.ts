import type { DesktopCapability, DesktopCapabilityMap, DesktopCapabilityReason } from '@shared/desktop/capabilities'
import { DESKTOP_CAPABILITY_ACTIONS } from '@shared/desktop/capabilities'
import type { DesktopSession } from '@shared/desktop/session'

function capability(
  action: DesktopCapability['action'],
  allowed: boolean,
  reason: DesktopCapability['reason']
): DesktopCapability {
  return { action, allowed, reason: allowed ? 'available' : reason }
}

const LOCAL_FILE_ACTIONS = new Set([
  'revealLocalFile',
  'pickLocalFolder',
  'rebindLocalRoot',
  'encryptAssets',
  'relocateAssetStorage',
  'playLocalFile'
])

const DESKTOP_TOOLS = new Set([
  'runPlugins',
  'runAgents',
  'cropAvatars',
  'openExternalLink'
])

export function createLocalDesktopCapabilities(): DesktopCapabilityMap {
  const localOnly = new Set([
    ...LOCAL_FILE_ACTIONS,
    ...DESKTOP_TOOLS,
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
  return createRemoteSessionCapabilities('disconnected')
}

export function createRemoteDesktopCapabilities(options: { frozen?: boolean } = {}): DesktopCapabilityMap {
  const frozen = options.frozen === true
  return Object.fromEntries(
    DESKTOP_CAPABILITY_ACTIONS.map((action) => {
      if (action === 'editCatalog' || action === 'manageBrowserPairing') {
        return [action, capability(action, !frozen, frozen ? 'catalogFrozen' : 'available')]
      }
      if (action === 'migrateCatalog') {
        return [action, capability(action, false, 'unsupportedOnServer')]
      }
      if (action === 'playRemoteFile' || DESKTOP_TOOLS.has(action)) {
        return [action, capability(action, true, 'available')]
      }
      if (LOCAL_FILE_ACTIONS.has(action)) {
        return [action, capability(action, false, 'remoteMode')]
      }
      return [action, capability(action, false, 'unsupportedOnServer')]
    })
  ) as DesktopCapabilityMap
}

export function createRemoteSessionCapabilities(
  state: DesktopSession['state'],
  frozen = false
): DesktopCapabilityMap {
  if (state === 'available' || state === 'frozen') {
    return createRemoteDesktopCapabilities({ frozen: frozen || state === 'frozen' })
  }
  const reason: DesktopCapabilityReason =
    state === 'versionMismatch'
      ? 'versionMismatch'
      : state === 'claimRequired' || state === 'recoveryRequired' || state === 'authInvalid'
        ? state === 'authInvalid'
          ? 'writerRevoked'
          : 'recoveryRequired'
        : state === 'modePrepRequired'
          ? 'needsLocalPrep'
          : 'disconnected'
  return Object.fromEntries(
    DESKTOP_CAPABILITY_ACTIONS.map((action) => {
      if (DESKTOP_TOOLS.has(action)) {
        return [action, capability(action, true, 'available')]
      }
      if (LOCAL_FILE_ACTIONS.has(action)) {
        return [action, capability(action, false, 'remoteMode')]
      }
      return [action, capability(action, false, reason)]
    })
  ) as DesktopCapabilityMap
}
