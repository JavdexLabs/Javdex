import { IPC } from '@shared/ipc-channels'
import type { PlayResult } from '@shared/libraryTypes'
import { createPlayerService } from '../services/playerService'
import { appCommandAdapter } from './appContractAdapter'
import type { CatalogBackend } from '../application/catalogBackend'
import type { DesktopSettingsStore } from '../application/desktopPorts'
import { removePlayedWatchLater } from '../application/watchLaterPlayback'

export function registerPlayerHandlers(
  backend: CatalogBackend,
  settings: DesktopSettingsStore
): void {
  const service = createPlayerService({
    catalog: backend,
    readPlayerPath: async () => (await settings.read()).playerPath
  })

  const afterPlayback = async (result: PlayResult, videoId?: number): Promise<PlayResult> => {
    if (result.ok && videoId != null) {
      try { await removePlayedWatchLater(backend, videoId) }
      catch (error) { console.warn('播放已开始，但未能从稍后观看移出影片', error) }
    }
    return result
  }
  appCommandAdapter.register(IPC.PLAYER_PLAY, async (libraryId, videoId): Promise<PlayResult> =>
    afterPlayback(await service.playVideo(libraryId, videoId), videoId))

  appCommandAdapter.register(IPC.PLAYER_REVEAL, (libraryId, videoId): PlayResult =>
    service.revealVideo(libraryId, videoId) as PlayResult
  )

  appCommandAdapter.register(
    IPC.PLAYER_OPEN_RESOURCE,
    async (libraryId, resourceId, videoId): Promise<PlayResult> =>
      afterPlayback(await service.openResource(libraryId, resourceId, videoId), videoId)
  )

  appCommandAdapter.register(
    IPC.PLAYER_REVEAL_RESOURCE,
    (libraryId, resourceId): PlayResult =>
      service.revealResource(libraryId, resourceId) as PlayResult
  )
}
