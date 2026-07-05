import { IPC } from '@shared/ipc-channels'
import type { PlayResult } from '@shared/types'
import { playVideo, playVideoFile, revealVideo, revealVideoFile } from '../services/playerService'
import { registerHandler } from './shared'

export function registerPlayerHandlers(): void {
  registerHandler(IPC.PLAYER_PLAY, (_e, videoId: number): Promise<PlayResult> =>
    playVideo(videoId)
  )

  registerHandler(IPC.PLAYER_REVEAL, (_e, videoId: number): PlayResult => revealVideo(videoId))

  registerHandler(IPC.PLAYER_PLAY_FILE, (_e, fileId: number): Promise<PlayResult> =>
    playVideoFile(fileId)
  )

  registerHandler(IPC.PLAYER_REVEAL_FILE, (_e, fileId: number): PlayResult =>
    revealVideoFile(fileId)
  )
}
