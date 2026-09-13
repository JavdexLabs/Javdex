import { IPC } from '@shared/ipc-channels'
import type { PlayResult } from '@shared/libraryTypes'
import { createPlayerService } from '../services/playerService'
import { appCommandAdapter } from './appContractAdapter'
import type { CatalogBackend } from '../application/catalogBackend'
import type { DesktopSettingsStore } from '../application/desktopPorts'

export function registerPlayerHandlers(
  backend: CatalogBackend,
  settings: DesktopSettingsStore
): void {
  const service = createPlayerService({
    catalog: backend,
    readPlayerPath: async () => (await settings.read()).playerPath
  })

  appCommandAdapter.register(IPC.PLAYER_PLAY, (libraryId, videoId): Promise<PlayResult> =>
    service.playVideo(libraryId, videoId)
  )

  appCommandAdapter.register(IPC.PLAYER_REVEAL, (libraryId, videoId): PlayResult =>
    service.revealVideo(libraryId, videoId) as PlayResult
  )

  appCommandAdapter.register(
    IPC.PLAYER_OPEN_RESOURCE,
    (libraryId, resourceId, videoId): Promise<PlayResult> =>
      service.openResource(libraryId, resourceId, videoId)
  )

  appCommandAdapter.register(
    IPC.PLAYER_REVEAL_RESOURCE,
    (libraryId, resourceId): PlayResult =>
      service.revealResource(libraryId, resourceId) as PlayResult
  )
}
