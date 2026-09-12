import { IPC } from '@shared/ipc-channels'
import type { PlayResult } from '@shared/libraryTypes'
import {
  openVideoResource,
  playVideo,
  revealVideo,
  revealVideoResource
} from '../services/playerService'
import { appCommandAdapter } from './appContractAdapter'

export function registerPlayerHandlers(): void {
  appCommandAdapter.register(IPC.PLAYER_PLAY, (libraryId, videoId): Promise<PlayResult> =>
    playVideo(libraryId, videoId)
  )

  appCommandAdapter.register(IPC.PLAYER_REVEAL, (libraryId, videoId): PlayResult =>
    revealVideo(libraryId, videoId)
  )

  appCommandAdapter.register(
    IPC.PLAYER_OPEN_RESOURCE,
    (libraryId, resourceId): Promise<PlayResult> =>
      openVideoResource(libraryId, resourceId)
  )

  appCommandAdapter.register(
    IPC.PLAYER_REVEAL_RESOURCE,
    (libraryId, resourceId): PlayResult =>
      revealVideoResource(libraryId, resourceId)
  )
}
