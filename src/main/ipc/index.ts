import { BrowserWindow } from 'electron'
import { registerActressHandlers } from './actressHandlers'
import { registerFacetHandlers } from './facetHandlers'
import { registerPlayerHandlers } from './playerHandlers'
import { registerPluginDevHandlers } from './pluginDevHandlers'
import { registerPlaylistHandlers } from './playlistHandlers'
import { registerScanHandlers } from './scanHandlers'
import { registerScrapeHandlers } from './scrapeHandlers'
import { registerSettingsHandlers } from './settingsHandlers'
import { registerVideoHandlers } from './videoHandlers'
import type { IpcContext } from './shared'

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  const ctx: IpcContext = { getWindow }

  registerSettingsHandlers(ctx)
  registerScanHandlers(ctx)
  registerVideoHandlers()
  registerPlaylistHandlers()
  registerActressHandlers()
  registerFacetHandlers()
  registerScrapeHandlers(ctx)
  registerPluginDevHandlers(ctx)
  registerPlayerHandlers()
}
