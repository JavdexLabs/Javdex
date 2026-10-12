import { app } from 'electron'
import path from 'node:path'
import { IPC } from '@shared/ipc-channels'
import type { CatalogBackend } from '../application/catalogBackend'
import type { IpcContext } from './shared'
import { createRecentPlayback } from '../player/recentPlayback'
import { appCommandAdapter, appEventAdapter } from './appContractAdapter'

export function registerRecentPlaybackHandlers(ctx: IpcContext, backend: CatalogBackend) {
  const history = createRecentPlayback(backend, path.join(app.getPath('userData'), 'recent-playback.json'), () => {
    const window = ctx.getWindow()
    if (window && !window.isDestroyed()) appEventAdapter.send(window.webContents, IPC.RECENT_PLAYBACK_CHANGED, null)
  })
  appCommandAdapter.register(IPC.RECENT_PLAYBACK_METADATA, history.metadata)
  appCommandAdapter.register(IPC.RECENT_PLAYBACK_PAGE, history.page)
  appCommandAdapter.register(IPC.RECENT_PLAYBACK_REMOVE, history.remove)
  appCommandAdapter.register(IPC.RECENT_PLAYBACK_CLEAR, history.clear)
  return async (videoId: number): Promise<void> => {
    try { await history.started(videoId) }
    catch { console.warn('[playback] unable to save device recent-playback history') }
  }
}
