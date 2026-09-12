import { BrowserWindow } from 'electron'
import { registerAssetHandlers } from './assetHandlers'
import { registerActressHandlers, type ActressHandlerDesktopQueries } from './actressHandlers'
import { registerFacetHandlers } from './facetHandlers'
import { registerPlayerHandlers } from './playerHandlers'
import { registerPluginDevHandlers } from './pluginDevHandlers'
import { registerPlaylistHandlers } from './playlistHandlers'
import { registerScanHandlers } from './scanHandlers'
import { registerScrapeHandlers } from './scrapeHandlers'
import { registerSettingsHandlers } from './settingsHandlers'
import { registerVideoHandlers, type VideoHandlerDesktopPorts } from './videoHandlers'
import { registerUpdateHandlers } from './updateHandlers'
import type { IpcContext } from './shared'
import { configureIpcSecurity } from './ipcSecurity'
import { registerLibraryCuratorHandlers } from './libraryCuratorHandlers'
import { registerAgentMetadataHandlers } from './agentMetadataHandlers'
import {
  registerMediaLibraryHandlers,
  type MediaLibraryHandlerDesktopPorts
} from './mediaLibraryHandlers'
import { registerPlaylistImportHandlers } from './playlistImportHandlers'
import { registerNfoExportHandlers } from './nfoExportHandlers'
import type { CatalogBackend } from '../application/catalogBackend'

export interface RegisterIpcHandlersOptions {
  backend: CatalogBackend
  videoDesktop?: VideoHandlerDesktopPorts
  actressDesktop?: ActressHandlerDesktopQueries
  mediaLibraryDesktop?: MediaLibraryHandlerDesktopPorts
}

export function registerIpcHandlers(
  getWindow: () => BrowserWindow | null,
  isTrustedUrl: (url: string) => boolean,
  options: RegisterIpcHandlersOptions
): void {
  const ctx: IpcContext = { getWindow }
  configureIpcSecurity({ getWindow, isTrustedUrl })

  registerSettingsHandlers(ctx)
  registerNfoExportHandlers(ctx)
  registerMediaLibraryHandlers(options.backend, options.mediaLibraryDesktop)
  registerUpdateHandlers(ctx)
  registerAssetHandlers()
  registerScanHandlers(ctx)
  registerVideoHandlers(options.backend, options.videoDesktop)
  registerPlaylistHandlers(options.backend)
  registerActressHandlers(options.backend, options.actressDesktop)
  registerFacetHandlers(options.backend)
  registerScrapeHandlers(ctx)
  registerPluginDevHandlers(ctx)
  registerLibraryCuratorHandlers()
  registerAgentMetadataHandlers(ctx)
  registerPlaylistImportHandlers(ctx)
  registerPlayerHandlers()
}
