import { IPC } from './ipc-channels'
import type { ActressFaceScanManifestItem, ActressListPage, ActressListQuery } from './types'

export interface ActressDeleteCleanupFailure {
  path: string
  error: string
}

export interface ActressDeleteResult {
  deletedCount: number
  unlinkedVideoCount: number
  cleanupFailures: ActressDeleteCleanupFailure[]
}

export type ActressDeleteMode = 'only-unlinked' | 'unlink-videos-and-delete'

export interface ActressDeleteRequest {
  ids: number[]
  mode: ActressDeleteMode
}

export interface ActressDeleteImpact {
  actressCount: number
  linkedActressCount: number
  affectedVideoCount: number
}

export interface ActressIpcContract {
  [IPC.ACTRESS_LIST_PAGE]: {
    args: [query?: ActressListQuery]
    result: ActressListPage
  }
  [IPC.ACTRESS_FACE_SCAN_MANIFEST]: {
    args: []
    result: ActressFaceScanManifestItem[]
  }
  [IPC.ACTRESS_DELETE]: {
    args: [request: ActressDeleteRequest]
    result: ActressDeleteResult
  }
  [IPC.ACTRESS_DELETE_BATCH]: {
    args: [request: ActressDeleteRequest]
    result: ActressDeleteResult
  }
  [IPC.ACTRESS_DELETE_PREVIEW]: {
    args: [ids: number[]]
    result: ActressDeleteImpact
  }
}

export type ActressIpcChannel = keyof ActressIpcContract
export type ActressIpcArgs<Channel extends ActressIpcChannel> = ActressIpcContract[Channel]['args']
export type ActressIpcResult<Channel extends ActressIpcChannel> = ActressIpcContract[Channel]['result']
