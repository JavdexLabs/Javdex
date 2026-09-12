import type { ProtocolVersions, RemoteInstanceIdentity } from './identity'

export type HandshakeReadyState = 'notBound' | 'ready' | 'frozen' | 'recovering' | 'migrating'

export interface HandshakeCapabilities {
  encryptedAssets: false
  transcoding: false
  arbitraryUrlProxy: false
  pluginExecution: false
  publicInternetDefault: false
  writerBound: boolean
  browserEnabled: boolean
  managementEnabled: true
}

export interface HandshakeResult extends ProtocolVersions {
  identity: Pick<RemoteInstanceIdentity, 'serverId' | 'catalogId'>
  writerEpoch: number
  ready: HandshakeReadyState
  capabilities: HandshakeCapabilities
}
