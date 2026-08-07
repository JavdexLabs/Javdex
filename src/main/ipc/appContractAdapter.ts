import type { AppIpcContract, AppIpcEventContract } from '@shared/appIpcContract'
import { createTypedEventAdapter, createTypedIpcAdapter } from './typedIpcAdapter'

export const appCommandAdapter = createTypedIpcAdapter<AppIpcContract>()
export const appEventAdapter = createTypedEventAdapter<AppIpcEventContract>()
