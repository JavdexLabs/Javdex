import type { AppIpcContract, AppIpcEventContract } from '@shared/appIpcContract'
import { createTypedEventAdapter, createTypedIpcAdapter } from './typedIpcAdapter'
import { appIpcSchemas } from './ipcCommandSchemas'

export const appCommandAdapter = createTypedIpcAdapter<AppIpcContract>(appIpcSchemas)
export const appEventAdapter = createTypedEventAdapter<AppIpcEventContract>()
