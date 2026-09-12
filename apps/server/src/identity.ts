import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { closeDatabase, initDatabaseAtPath, isDatabaseOpen } from '@library/db/database'
import { ensureCatalogIdentity, isWriterBound } from '@library/catalog/catalogIdentity'
import { issueOneTimeToken, type IssuedOneTimeToken } from '@library/catalog/catalogWriter'
import { configureLibraryHost } from '@library/runtime/host'
import { ensureMediaAssetDirsAt } from '@library/assetStoragePaths'
import type { ServerConfig } from './config'
import { ensureLocalDataDir } from './filesystem'
import { createSharpImageCodec } from './imageCodec'

export function configureServerLibraryHost(config: ServerConfig): void {
  configureLibraryHost({
    userDataPath: () => config.dataDir,
    images: createSharpImageCodec(),
    assets: {
      assetEncryption: () => false,
      mediaAssetsPath: () => config.imagesDir
    },
    mediaMounts: () => config.mediaMounts
  })
}

export function ensureServerCatalog(
  config: ServerConfig,
  options: { bootstrapToken?: string } = {}
): ReturnType<typeof ensureCatalogIdentity> {
  const identity = ensureCatalogIdentity({ serverId: randomUUID() })
  if (!isWriterBound() && options.bootstrapToken) {
    issueOneTimeToken('initialBind', { token: options.bootstrapToken })
  }
  return identity
}

/** One-time bind/recover tokens. Not occupancy files, writer secrets, or recovery passwords. */
export function issueDeployToken(
  config: ServerConfig,
  kind: 'initialBind' | 'deployRecover',
  options: { bootstrapToken?: string } = {}
): IssuedOneTimeToken {
  const owned = !isDatabaseOpen()
  if (owned) {
    ensureLocalDataDir(config.dataDir)
    configureServerLibraryHost(config)
    ensureMediaAssetDirsAt(config.imagesDir)
    initDatabaseAtPath(path.join(config.dataDir, 'library.db'))
  }
  try {
    ensureCatalogIdentity({ serverId: randomUUID() })
    if (kind === 'initialBind' && options.bootstrapToken) {
      return issueOneTimeToken('initialBind', { token: options.bootstrapToken })
    }
    return issueOneTimeToken(kind)
  } finally {
    if (owned) closeDatabase()
  }
}
