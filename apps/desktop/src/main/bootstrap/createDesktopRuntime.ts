import path from 'node:path'
import type { CatalogBackend } from '../application/catalogBackend'
import { createCatalogBackendForMode } from '../backends/local/localCatalogBackend'
import {
  createThisComputerSettingsStore,
  thisComputerSettingsPath
} from '../desktop/thisComputerSettingsStore'
import {
  loadOrCreateLocalCatalogIdentity,
  localCatalogIdentityPath
} from '../desktop/localCatalogIdentity'
import { openDesktopWorkStore, type DesktopWorkStoreHandle } from '../desktop/workStore'
import { structuredError } from '@shared/protocol/errors'

export interface DesktopRuntime {
  mode: 'local' | 'remote'
  backend: CatalogBackend
  workStore: DesktopWorkStoreHandle
  dispose(): Promise<void>
}

export function workStorePath(userDataPath: string): string {
  return path.join(userDataPath, 'desktop-work.db')
}

/**
 * Choose local or unconfigured-remote assembly from this-computer settings.
 * Remote must not open library.db. A workStore copy left in `copying` must
 * return to local mode; idle (nothing to copy) and ready are allowed.
 */
export async function createDesktopRuntime(
  userDataPath: string,
  appVersion: string
): Promise<DesktopRuntime> {
  const settings = createThisComputerSettingsStore(thisComputerSettingsPath(userDataPath))
  const workStore = openDesktopWorkStore(workStorePath(userDataPath))
  const mode = (await settings.read()).mode

  if (mode === 'remote' && workStore.prepStatus() === 'copying') {
    workStore.close()
    throw structuredError(
      'MODE_PREP_REQUIRED',
      '工作记录尚未完成复制。请先回到本地模式完成准备，不要在远程模式补开原资料库。'
    )
  }

  const backend =
    mode === 'remote'
      ? createCatalogBackendForMode('remote', {
          identity: { mode: 'local', catalogId: '' }
        })
      : createCatalogBackendForMode('local', {
          identity: loadOrCreateLocalCatalogIdentity(localCatalogIdentityPath(userDataPath)),
          appVersion
        })

  return {
    mode,
    backend,
    workStore,
    async dispose(): Promise<void> {
      await backend.dispose()
      workStore.close()
    }
  }
}
