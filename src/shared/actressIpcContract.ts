import { IPC } from './ipc-channels'
import type { ActressListPage, ActressListQuery } from './types'

export interface ActressDeleteCleanupFailure {
  path: string
  error: string
}

export interface ActressDeleteResult {
  deletedCount: number
  cleanupFailures: ActressDeleteCleanupFailure[]
}

export interface ActressIpcContract {
  [IPC.ACTRESS_LIST_PAGE]: {
    args: [query?: ActressListQuery]
    result: ActressListPage
  }
  [IPC.ACTRESS_DELETE]: {
    args: [id: number]
    result: ActressDeleteResult
  }
  [IPC.ACTRESS_DELETE_BATCH]: {
    args: [ids: number[]]
    result: ActressDeleteResult
  }
}

export type ActressIpcChannel = keyof ActressIpcContract
export type ActressIpcArgs<Channel extends ActressIpcChannel> = ActressIpcContract[Channel]['args']
export type ActressIpcResult<Channel extends ActressIpcChannel> = ActressIpcContract[Channel]['result']
