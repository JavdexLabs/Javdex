import { IPC } from './ipc-channels'

export interface ActressDeleteCleanupFailure {
  path: string
  error: string
}

export interface ActressDeleteResult {
  deletedCount: number
  cleanupFailures: ActressDeleteCleanupFailure[]
}

export interface ActressDeleteIpcContract {
  [IPC.ACTRESS_DELETE]: {
    args: [id: number]
    result: ActressDeleteResult
  }
  [IPC.ACTRESS_DELETE_BATCH]: {
    args: [ids: number[]]
    result: ActressDeleteResult
  }
}

export type ActressDeleteIpcChannel = keyof ActressDeleteIpcContract
export type ActressDeleteIpcArgs<Channel extends ActressDeleteIpcChannel> =
  ActressDeleteIpcContract[Channel]['args']
export type ActressDeleteIpcResult<Channel extends ActressDeleteIpcChannel> =
  ActressDeleteIpcContract[Channel]['result']
