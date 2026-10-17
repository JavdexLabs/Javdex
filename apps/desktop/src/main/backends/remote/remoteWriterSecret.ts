import type { HandshakeResult } from '@shared/protocol/handshake'
import { structuredError } from '@shared/protocol/errors'
import type { RemoteCatalogBackendOptions } from './remoteCatalogBackend'

/** Catalog credentials may survive a restore, but never a different server. */
export async function readRemoteWriterSecret(options: RemoteCatalogBackendOptions, hello: HandshakeResult): Promise<string | null> {
  if (options.deviceIdentity && options.deviceIdentity.serverId !== hello.identity.serverId) {
    throw structuredError('INSTANCE_MISMATCH', '服务端身份已变化，已保留原连接和授权，请核对地址')
  }
  if (options.connectionMigration && !options.connectionMigration.completed) options.connectionMigration.checkIdentity(hello)
  return await options.credentials.readWriterSecret(hello.identity.catalogId) ?? options.deviceIdentity?.secret ?? null
}
