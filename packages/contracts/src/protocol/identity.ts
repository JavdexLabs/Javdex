export type CatalogMode = 'local' | 'remote'

export interface CatalogIdentity {
  mode: CatalogMode
  /**
   * Local identity is stable per user-data catalog directory, not a path string.
   * Remote identity is the server-issued catalogId.
   */
  catalogId: string
  /** Present only for remote catalogs. */
  serverId?: string
}

export interface RemoteInstanceIdentity {
  serverId: string
  catalogId: string
  writerEpoch: number
}

export interface ProtocolVersions {
  protocolVersion: number
  appVersion: string
  schemaVersion: number
}

export const MANAGE_PROTOCOL_VERSION = 1
