import { BrowserWindow } from 'electron'
import { registerAssetHandlers } from './assetHandlers'
import { registerActressHandlers } from './actressHandlers'
import { registerFacetHandlers } from './facetHandlers'
import { registerPlayerHandlers } from './playerHandlers'
import { registerPluginDevHandlers } from './pluginDevHandlers'
import { registerPlaylistHandlers } from './playlistHandlers'
import { registerScanHandlers } from './scanHandlers'
import { registerScrapeHandlers } from './scrapeHandlers'
import { registerSettingsHandlers } from './settingsHandlers'
import { registerVideoHandlers } from './videoHandlers'
import { registerUpdateHandlers } from './updateHandlers'
import type { IpcContext } from './shared'
import { configureIpcSecurity } from './ipcSecurity'
import { registerLibraryCuratorHandlers } from './libraryCuratorHandlers'
import { registerAgentMetadataHandlers } from './agentMetadataHandlers'
import { registerMediaLibraryHandlers } from './mediaLibraryHandlers'
import { registerPlaylistImportHandlers } from './playlistImportHandlers'
import { registerNfoExportHandlers } from './nfoExportHandlers'

export function registerIpcHandlers(
  getWindow: () => BrowserWindow | null,
  isTrustedUrl: (url: string) => boolean
): void {
  const ctx: IpcContext = { getWindow }
  configureIpcSecurity({ getWindow, isTrustedUrl })

  registerSettingsHandlers(ctx)
  registerNfoExportHandlers(ctx)
  registerMediaLibraryHandlers()
  registerUpdateHandlers(ctx)
  registerAssetHandlers()
  registerScanHandlers(ctx)
  registerVideoHandlers()
  registerPlaylistHandlers()
  registerActressHandlers()
  registerFacetHandlers()
  registerScrapeHandlers(ctx)
  registerPluginDevHandlers(ctx)
  registerLibraryCuratorHandlers()
  registerAgentMetadataHandlers(ctx)
  registerPlaylistImportHandlers(ctx)
  registerPlayerHandlers()
}
