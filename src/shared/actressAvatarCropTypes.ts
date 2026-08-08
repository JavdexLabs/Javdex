export interface ActressAvatarAutoCropTarget {
  actressId: number
  mainName: string
}

export type ActressAvatarAutoCropStatus = 'success' | 'skipped' | 'failed'

export interface ActressAvatarAutoCropOutcome {
  status: ActressAvatarAutoCropStatus
  message?: string
}

export interface ActressAvatarAutoCropRequest extends ActressAvatarAutoCropTarget {
  requestId: string
}

export interface ActressAvatarAutoCropResponse extends ActressAvatarAutoCropOutcome {
  requestId: string
}
