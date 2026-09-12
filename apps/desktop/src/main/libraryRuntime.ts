import { app } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { readTestUserDataPath } from '@shared/appIdentity'
import { resolveScrapeProxyUrl } from '@shared/settingsTypes'
import { configureLibraryHost } from '@library/runtime/host'
import { createElectronImageCodec } from './nativeImageCodec'
import { configureCatalogReadWorkerEntry } from './services/catalogReadService'
import { getSettings } from './settings/settingsStore'

function desktopAssetSettings() {
  return {
    assetEncryption: () => getSettings().assetEncryption === true,
    mediaAssetsPath: () => getSettings().mediaAssetsPath?.trim() || null
  }
}

function desktopHttpSettings() {
  return {
    scrapeProxyUrl: () => resolveScrapeProxyUrl(getSettings())
  }
}

export function configureDesktopLibraryRuntime(): void {
  configureLibraryHost({
    userDataPath: () => app.getPath('userData'),
    images: createElectronImageCodec(),
    assets: desktopAssetSettings(),
    http: desktopHttpSettings()
  })
  configureCatalogReadWorkerEntry(path.join(app.getAppPath(), 'out/main/catalogReadWorker.js'))
}

export function configureDesktopLibraryTestRuntime(): void {
  configureLibraryHost({
    userDataPath: () =>
      readTestUserDataPath() ?? path.join(os.tmpdir(), 'Javdex-test-user-data'),
    images: createElectronImageCodec(),
    assets: desktopAssetSettings(),
    http: desktopHttpSettings()
  })
}

