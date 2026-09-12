import fs from 'node:fs'
import path from 'node:path'
import { closeDatabase, initDatabaseAtPath } from '@library/db/database'
import {
  recoverInterruptedLibraryScanRuns,
  type InterruptedLibraryScanRecoveryResult
} from '@library/db/libraryScanRepo'
import { recoverCatalogMaintenance } from '@library/catalog/catalogMaintenanceRecover'
import { configureAgentWorkTablePrefix } from '@library/runtime/host'
import type { CatalogBackend } from '../application/catalogBackend'
import {
  configureAgentRunDatabase,
  resetAgentRunDatabaseForTests
} from '../agent-platform/agentRunStore'
import {
  createCatalogBackendForMode,
  type LocalCatalogBackendDependencies
} from '../backends/local/localCatalogBackend'
import {
  createThisComputerSettingsStore,
  thisComputerSettingsPath
} from '../desktop/thisComputerSettingsStore'
import {
  loadOrCreateLocalCatalogIdentity,
  localCatalogIdentityPath
} from '../desktop/localCatalogIdentity'
import { attachAgentWorkStore, copyAgentWorkTables } from '../desktop/agentWorkCopy'
import { createWriterCredentialStore } from '../desktop/writerCredentialStore'
import { openDesktopWorkStore, type DesktopWorkStoreHandle } from '../desktop/workStore'
import { createUnconfiguredRemoteBackend } from '../backends/remote/unconfiguredRemoteBackend'

export interface DesktopRuntime {
  mode: 'local' | 'remote'
  backend: CatalogBackend
  workStore: DesktopWorkStoreHandle
  settings: ReturnType<typeof createThisComputerSettingsStore>
  openedCatalog: boolean
  scanRecovery: InterruptedLibraryScanRecoveryResult | null
  dispose(): Promise<void>
}

export interface CreateDesktopRuntimeOptions {
  local?: Omit<Partial<LocalCatalogBackendDependencies>, 'identity'>
}

export function workStorePath(userDataPath: string): string {
  return path.join(userDataPath, 'desktop-work.db')
}

export function localCatalogDatabasePath(userDataPath: string): string {
  return path.join(userDataPath, 'data', 'library.db')
}

function resetDesktopWorkBindings(): void {
  configureAgentWorkTablePrefix('')
  resetAgentRunDatabaseForTests()
}

/**
 * Choose local or remote assembly from this-computer settings.
 * Remote must not open library.db. A workStore copy left in `copying`, or an
 * existing catalog that has not been copied yet, must return to local mode.
 */
export async function createDesktopRuntime(
  userDataPath: string,
  appVersion: string,
  options: CreateDesktopRuntimeOptions = {}
): Promise<DesktopRuntime> {
  const settings = createThisComputerSettingsStore(thisComputerSettingsPath(userDataPath))
  const workStore = openDesktopWorkStore(workStorePath(userDataPath))
  const snapshot = await settings.read()
  const mode = snapshot.mode
  const catalogPath = localCatalogDatabasePath(userDataPath)
  const catalogExists = fs.existsSync(catalogPath)

  const disposeRemote = async (backend: CatalogBackend): Promise<void> => {
    resetDesktopWorkBindings()
    await backend.dispose()
    workStore.close()
  }

  if (mode === 'remote') {
    const prepBlocked =
      workStore.prepStatus() === 'copying' || (workStore.prepStatus() !== 'ready' && catalogExists)
    configureAgentRunDatabase(() => workStore.database())
    if (prepBlocked) {
      const backend = createUnconfiguredRemoteBackend({
        state: 'modePrepRequired',
        message: '工作记录尚未完成复制。请先回到本地模式完成准备，不要在远程模式补开原资料库。'
      })
      return {
        mode,
        backend,
        workStore,
        settings,
        openedCatalog: false,
        scanRecovery: null,
        dispose: () => disposeRemote(backend)
      }
    }
    const credentials = createWriterCredentialStore({ userDataPath })
    const backend = createCatalogBackendForMode(
      'remote',
      { identity: { mode: 'local', catalogId: '' } },
      snapshot.remoteBaseUrl
        ? {
            baseUrl: snapshot.remoteBaseUrl,
            appVersion,
            credentials,
            workStore
          }
        : undefined
    )
    await backend.reconnect()
    return {
      mode,
      backend,
      workStore,
      settings,
      openedCatalog: false,
      scanRecovery: null,
      dispose: () => disposeRemote(backend)
    }
  }

  fs.mkdirSync(path.dirname(catalogPath), { recursive: true })
  const database = initDatabaseAtPath(catalogPath)
  if (workStore.prepStatus() !== 'ready') {
    workStore.beginCopy()
    copyAgentWorkTables(database, workStore.database())
    workStore.markReady()
  }
  attachAgentWorkStore(database, workStore.filePath)
  configureAgentRunDatabase(() => workStore.database())
  const scanRecovery = recoverInterruptedLibraryScanRuns(database)
  recoverCatalogMaintenance(database)
  const backend = createCatalogBackendForMode('local', {
    identity: loadOrCreateLocalCatalogIdentity(localCatalogIdentityPath(userDataPath)),
    appVersion,
    ...options.local
  })

  return {
    mode,
    backend,
    workStore,
    settings,
    openedCatalog: true,
    scanRecovery,
    async dispose(): Promise<void> {
      resetDesktopWorkBindings()
      await backend.dispose()
      closeDatabase()
      workStore.close()
    }
  }
}
