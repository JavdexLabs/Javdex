import { IPC } from './ipc-channels'
import type {
  NfoExportOptions,
  NfoExportPlanPreview,
  NfoExportPlanRequest,
  NfoExportPreferences,
  NfoExportProgressEvent,
  NfoExportStartResult,
  NfoExportStateEvent
} from './nfoExportTypes'
import type {
  IpcContractArgs,
  IpcContractChannel,
  IpcContractResult,
  IpcEventChannel,
  IpcEventPayload
} from './typedIpcContract'

export interface NfoExportIpcContract {
  [IPC.NFO_EXPORT_GET_OPTIONS]: { args: []; result: NfoExportOptions }
  [IPC.NFO_EXPORT_UPDATE_PREFERENCES]: {
    args: [preferences: NfoExportPreferences]
    result: NfoExportPreferences
  }
  [IPC.NFO_EXPORT_PLAN]: { args: [request: NfoExportPlanRequest]; result: NfoExportPlanPreview }
  [IPC.NFO_EXPORT_DISCARD_PLAN]: { args: [planId: string]; result: void }
  [IPC.NFO_EXPORT_START]: { args: [planId: string]; result: NfoExportStartResult }
  [IPC.NFO_EXPORT_TERMINATE]: { args: [taskId: string]; result: void }
}

export interface NfoExportIpcEventContract {
  [IPC.NFO_EXPORT_PROGRESS]: NfoExportProgressEvent
  [IPC.NFO_EXPORT_STATE]: NfoExportStateEvent
}

export type NfoExportIpcChannel = IpcContractChannel<NfoExportIpcContract>
export type NfoExportIpcArgs<Channel extends NfoExportIpcChannel> =
  IpcContractArgs<NfoExportIpcContract, Channel>
export type NfoExportIpcResult<Channel extends NfoExportIpcChannel> =
  IpcContractResult<NfoExportIpcContract, Channel>
export type NfoExportIpcEventChannel = IpcEventChannel<NfoExportIpcEventContract>
export type NfoExportIpcEvent<Channel extends NfoExportIpcEventChannel> =
  IpcEventPayload<NfoExportIpcEventContract, Channel>
