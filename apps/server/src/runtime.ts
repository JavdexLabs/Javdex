import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDatabase, initDatabaseAtPath } from '@library/db/database'
import { recoverInterruptedLibraryScanRuns } from '@library/db/libraryScanRepo'
import { configureLibraryHost } from '@library/runtime/host'
import { ensureMediaAssetDirsAt } from '@library/assetStoragePaths'
import { createWorkerWebCatalog } from '@http/catalogWorkerAdapter'
import { WebServer } from '@http/server'
import { WebSessions } from '@http/auth'
import { constrainMediaToMounts, gateCatalogUntilBound } from './catalogGate'
import type { ServerConfig } from './config'
import { acquireDataDirLock, ensureLocalDataDir, ensureMediaMounts } from './filesystem'
import { isInstanceBound } from './identity'
import { assertSharpDecode, createSharpImageCodec } from './imageCodec'
import { WebCatalogWorkerClient } from './webCatalogWorkerClient'

export interface JavdexServerHandle {
  port: number
  dataDir: string
  stop(signal?: NodeJS.Signals): Promise<void>
}

export function defaultWebCatalogWorkerEntry(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'webCatalogWorker.js')
}

export async function startJavdexServer(
  config: ServerConfig,
  options: { workerEntry?: string } = {}
): Promise<JavdexServerHandle> {
  if (process.versions.electron) {
    throw new Error('服务器宿主不能在 Electron 中启动')
  }
  await assertSharpDecode()
  ensureLocalDataDir(config.dataDir)
  const mountRoots = ensureMediaMounts(config.dataDir, config.imagesDir, config.mediaMounts)
  const lock = acquireDataDirLock(config.dataDir)
  let worker: WebCatalogWorkerClient | undefined
  let http: WebServer | undefined
  let ready = false
  let stopping = false
  const fail = async (error: unknown): Promise<never> => {
    try {
      await http?.stop()
    } catch {
      // Keep the original startup error.
    }
    try {
      await worker?.dispose()
    } catch {
      // Keep the original startup error.
    }
    closeDatabase()
    lock.release()
    throw error
  }
  try {
    configureLibraryHost({
      userDataPath: () => config.dataDir,
      images: createSharpImageCodec(),
      assets: {
        assetEncryption: () => false,
        mediaAssetsPath: () => config.imagesDir
      }
    })
    ensureMediaAssetDirsAt(config.imagesDir)
    const database = initDatabaseAtPath(path.join(config.dataDir, 'library.db'))
    recoverInterruptedLibraryScanRuns(database)
    const workerEntry = options.workerEntry ?? defaultWebCatalogWorkerEntry()
    if (!fs.existsSync(workerEntry)) {
      throw new Error(`缺少 catalog 查询 worker: ${workerEntry}`)
    }
    worker = new WebCatalogWorkerClient(workerEntry, database.name)
    const catalog = gateCatalogUntilBound(
      constrainMediaToMounts(createWorkerWebCatalog(database, worker), mountRoots),
      () => isInstanceBound(config.dataDir)
    )
    const sessions = new WebSessions(Date.now, path.join(config.dataDir, 'web-devices.json'))
    http = new WebServer({
      username: config.web.username,
      passwordHash: config.web.passwordHash,
      staticRoot: config.staticRoot,
      catalog,
      sessions,
      listenHost: config.listenHost,
      accessHosts: config.accessHosts,
      surface: 'browser',
      probes: {
        live: () => ({ status: 'live' }),
        ready: () =>
          ready && !stopping ? { ready: true } : { ready: false, reason: stopping ? 'stopping' : 'starting' }
      }
    })
    const port = await http.start(config.port, config.listenHost)
    ready = true
    return {
      port,
      dataDir: config.dataDir,
      async stop(_signal?: NodeJS.Signals): Promise<void> {
        stopping = true
        ready = false
        try {
          await http?.stop()
        } finally {
          await worker?.dispose()
          closeDatabase()
          lock.release()
        }
      }
    }
  } catch (error) {
    return await fail(error)
  }
}
