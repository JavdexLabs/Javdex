import type Database from 'better-sqlite3'
import { CURRENT_SCHEMA_VERSION } from '@library/db/migrations'
import { MANAGE_PROTOCOL_VERSION } from '@shared/protocol/identity'
import type { HandshakeReadyState, HandshakeResult } from '@shared/protocol/handshake'
import { structuredError } from '@shared/protocol/errors'
import { getDb } from '@library/db/database'
import { readCatalogIdentity } from './catalogIdentity'

export function readHandshake(
  options: { appVersion: string; browserEnabled: boolean },
  database: Database.Database = getDb()
): HandshakeResult {
  const identity = readCatalogIdentity(database)
  if (!identity?.serverId) {
    throw structuredError('INSTANCE_MISMATCH', '服务端实例尚未分配 serverId')
  }
  const bound = identity.writerEpoch > 0
  const ready: HandshakeReadyState = identity.frozen ? 'frozen' : bound ? 'ready' : 'notBound'
  return {
    protocolVersion: MANAGE_PROTOCOL_VERSION,
    appVersion: options.appVersion,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    identity: { serverId: identity.serverId, catalogId: identity.catalogId },
    writerEpoch: identity.writerEpoch,
    ready,
    capabilities: {
      encryptedAssets: false,
      transcoding: false,
      arbitraryUrlProxy: false,
      pluginExecution: false,
      publicInternetDefault: false,
      writerBound: bound,
      browserEnabled: options.browserEnabled,
      managementEnabled: true
    }
  }
}
