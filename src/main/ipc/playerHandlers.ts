import { IPC } from '@shared/ipc-channels'
import type { PlayResult } from '@shared/types'
import { playVideo, revealVideo } from '../services/playerService'
import { registerHandler } from './shared'

export function registerPlayerHandlers(): void {
  registerHandler(IPC.PLAYER_PLAY, (_e, videoId: number): Promise<PlayResult> =>
    playVideo(videoId)
  )

  registerHandler(IPC.PLAYER_REVEAL, (_e, videoId: number): PlayResult => revealVideo(videoId))
}
