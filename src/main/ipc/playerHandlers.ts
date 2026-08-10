import { IPC } from '@shared/ipc-channels'
import type { PlayResult } from '@shared/libraryTypes'
import {
  openVideoResource,
  playVideo,
  playVideoFile,
  revealVideo,
  revealVideoFile
} from '../services/playerService'
import { appCommandAdapter } from './appContractAdapter'

export function registerPlayerHandlers(): void {
  appCommandAdapter.register(IPC.PLAYER_PLAY, (videoId): Promise<PlayResult> =>
    playVideo(videoId)
  )

  appCommandAdapter.register(IPC.PLAYER_REVEAL, (videoId): PlayResult => revealVideo(videoId))

  appCommandAdapter.register(IPC.PLAYER_PLAY_FILE, (fileId): Promise<PlayResult> =>
    playVideoFile(fileId)
  )

  appCommandAdapter.register(IPC.PLAYER_REVEAL_FILE, (fileId): PlayResult =>
    revealVideoFile(fileId)
  )

  appCommandAdapter.register(IPC.PLAYER_OPEN_RESOURCE, (resourceId): Promise<PlayResult> =>
    openVideoResource(resourceId)
  )
}
