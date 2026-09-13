import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDatabase, initDatabaseAtPath } from '@library/db/database'
import { recoverInterruptedLibraryScanRuns } from '@library/db/libraryScanRepo'
import { recoverCatalogImages } from '@library/catalog/catalogImageRecovery'
import { recoverCatalogMaintenance } from '@library/catalog/catalogMaintenanceRecover'
import { inspectPlayStream, setPlayGrantListener } from '@library/catalog/catalogPlay'
import { closePlayStreams } from '@http/play'
import { scanCoordinator } from '@library/scan/scanCoordinator'
import { isWriterBound } from '@library/catalog/catalogIdentity'
import { ensureMediaAssetDirsAt } from '@library/assetStoragePaths'
import { createWorkerWebCatalog } from '@http/catalogWorkerAdapter'
import { WebServer } from '@http/server'
import { WebSessions } from '@http/auth'
import { constrainMediaToMounts, gateCatalogUntilBound } from './catalogGate'
import type { ServerConfig } from './config'
import { acquireDataDirLock, ensureLocalDataDir, ensureMediaMounts } from './filesystem'
import { configureServerLibraryHost, ensureServerCatalog } from './identity'
import { assertSharpDecode } from './imageCodec'
import { dispatchManageOperation, putManageUpload, getManageAsset } from './manageDispatch'
import { SERVER_APP_VERSION } from './appVersion'
import { WebCatalogWorkerClient } from './webCatalogWorkerClient'
import {
  setManageBrowserSurface,
  type ManageBrowserStatus,
  type ManageBrowserSurface
} from './manageBrowser'

export interface JavdexServerHandle {
  port: number
  dataDir: string
  stop(signal?: NodeJS.Signals): Promise<void>
}

export function defaultWebCatalogWorkerEntry(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'webCatalogWorker.js')
}

const BROWSER_SURFACE_FILE = 'browser-surface.json'

function loadBrowserEnabled(dataDir: string): boolean {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(dataDir, BROWSER_SURFACE_FILE), 'utf8')
    ) as { enabled?: unknown }
    return raw.enabled !== false
  } catch {
    return true
  }
}

function persistBrowserEnabled(dataDir: string, enabled: boolean): void {
  fs.writeFileSync(path.join(dataDir, BROWSER_SURFACE_FILE), JSON.stringify({ enabled }), {
    mode: 0o600
  })
}

function createBrowserSurface(
  http: WebServer,
  config: ServerConfig,
  port: number
): ManageBrowserSurface {
  const status = (): ManageBrowserStatus => ({
    enabled: http.browserEnabled,
    running: http.browserEnabled,
    port,
    username: config.web.username,
    hasPassword: true,
    urls: (config.accessHosts.length > 0 ? config.accessHosts : ['127.0.0.1']).map(
      (host) => `http://${host}:${port}`
    ),
    devices: http.devices,
    pairingUntil: http.pairing.enabledUntil,
    pairingActivity: http.pairing.activity(),
    sessions: http.sessionCount,
    error: null
  })
  return {
    status,
    setEnabled(enabled) {
      http.setBrowserEnabled(enabled)
      persistBrowserEnabled(config.dataDir, enabled)
      return status()
    },
    pairOpen() {
      http.pairing.open()
      return status()
    },
    pairInspect(code) {
      return http.pairing.inspect(code)
    },
    pairDecide(code, approve) {
      http.pairing.decide(code, approve)
      return status()
    },
    deviceRemove(id) {
      http.removeDevice(id)
      return status()
    },
    deviceRename(id, name) {
      http.renameDevice(id, name)
      return status()
    },
    deviceReset(id) {
      http.removeDevice(id)
      return status()
    },
    revokeSessions() {
      http.revokeSessions()
      return status()
    }
  }
}

export async function startJavdexServer(
  config: ServerConfig,
  options: { workerEntry?: string; bootstrapToken?: string } = {}
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
    setPlayGrantListener(null)
    setManageBrowserSurface(null)
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
    configureServerLibraryHost(config)
    ensureMediaAssetDirsAt(config.imagesDir)
    const database = initDatabaseAtPath(path.join(config.dataDir, 'library.db'))
    recoverInterruptedLibraryScanRuns(database)
    recoverCatalogImages(database)
    recoverCatalogMaintenance(database)
    ensureServerCatalog(config, { bootstrapToken: isWriterBound(database) ? undefined : options.bootstrapToken })
    const workerEntry = options.workerEntry ?? defaultWebCatalogWorkerEntry()
    if (!fs.existsSync(workerEntry)) {
      throw new Error(`缺少 catalog 查询 worker: ${workerEntry}`)
    }
    worker = new WebCatalogWorkerClient(workerEntry, database.name)
    const catalog = gateCatalogUntilBound(
      constrainMediaToMounts(createWorkerWebCatalog(database, worker), mountRoots),
      () => isWriterBound(database)
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
      },
      manage: {
        appVersion: SERVER_APP_VERSION,
        dispatch: (context) => dispatchManageOperation(context, database),
        putUpload: (context) => putManageUpload(context, database),
        getAsset: (context) => getManageAsset(context, database)
      },
      play: {
        inspect: (input) => inspectPlayStream(input, database)
      }
    })
    http.setBrowserEnabled(loadBrowserEnabled(config.dataDir))
    setPlayGrantListener({
      onRevoke(grantIds) {
        closePlayStreams(grantIds)
      }
    })
    const port = await http.start(config.port, config.listenHost)
    setManageBrowserSurface(createBrowserSurface(http, config, port))
    ready = true
    return {
      port,
      dataDir: config.dataDir,
      async stop(_signal?: NodeJS.Signals): Promise<void> {
        stopping = true
        ready = false
        try {
          await scanCoordinator.stopAndDrain()
        } catch {
          // Drain before closing the catalog; keep stopping even if cancel races.
        }
        try {
          await http?.stop()
        } finally {
          setPlayGrantListener(null)
          setManageBrowserSurface(null)
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
