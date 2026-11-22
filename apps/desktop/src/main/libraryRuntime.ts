import { app } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { readTestUserDataPath } from '@shared/appIdentity'
import { resolveScrapeProxyUrl } from '@shared/settingsTypes'
import { configureLibraryHost } from '@library/runtime/host'
import { createElectronImageCodec } from './nativeImageCodec'
import { configureCatalogReadWorkerEntry } from './services/catalogReadService'
import { getSettings } from './settings/settingsStore'
import { networkProxySession, proxyCandidates } from './utils/networkProxyTransport'

function desktopAssetSettings() {
  return {
    assetEncryption: () => getSettings().assetEncryption === true,
    mediaAssetsPath: () => getSettings().mediaAssetsPath?.trim() || null
  }
}

function desktopHttpSettings() {
  return {
    scrapeProxyUrl: () => resolveScrapeProxyUrl(getSettings()),
    resolveScrapeProxyUrls: async (url: URL) => {
      const setting = resolveScrapeProxyUrl(getSettings())
      if (setting) return [setting === 'direct://' ? '' : setting]
      const network = await networkProxySession('scrape-assets', { mode: 'system' })
      return proxyCandidates(await network.resolveProxy(url.href))
    }
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
