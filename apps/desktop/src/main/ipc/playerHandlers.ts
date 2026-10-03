import { IPC } from '@shared/ipc-channels'
import type { PlayResult } from '@shared/libraryTypes'
import { createPlayerService } from '../services/playerService'
import { appCommandAdapter } from './appContractAdapter'
import type { CatalogBackend } from '../application/catalogBackend'
import type { DesktopSettingsStore } from '../application/desktopPorts'
import { removePlayedWatchLater } from '../application/watchLaterPlayback'
import type { PlaybackTarget } from '@shared/desktop/playback'

export function registerPlayerHandlers(
  backend: CatalogBackend,
  settings: DesktopSettingsStore,
  openBuiltin: (target: PlaybackTarget) => Promise<PlayResult>
): void {
  const service = createPlayerService({
    catalog: backend,
    readPlayerPath: async () => (await settings.read()).playerPath,
    readPlayerPreference: async () => (await settings.read()).playerPreference,
    openBuiltin,
    externalStarted: async videoId => { await removePlayedWatchLater(backend, videoId) }
  })
  appCommandAdapter.register(IPC.PLAYER_PLAY, async (libraryId, videoId): Promise<PlayResult> =>
    service.playVideo(libraryId, videoId))

  appCommandAdapter.register(IPC.PLAYER_REVEAL, (libraryId, videoId): PlayResult =>
    service.revealVideo(libraryId, videoId) as PlayResult
  )

  appCommandAdapter.register(
    IPC.PLAYER_OPEN_RESOURCE,
    async (libraryId, resourceId, videoId, player): Promise<PlayResult> =>
      service.openResource(libraryId, resourceId, videoId, player)
  )

  appCommandAdapter.register(
    IPC.PLAYER_REVEAL_RESOURCE,
    (libraryId, resourceId): PlayResult =>
      service.revealResource(libraryId, resourceId) as PlayResult
  )
}
