import type {
  NfoExportIpcContract,
  NfoExportIpcEventContract
} from '@shared/nfoExportIpcContract'
import { createTypedEventAdapter, createTypedIpcAdapter } from './typedIpcAdapter'
import { nfoExportIpcSchemas } from './nfoExportIpcSchemas'

export const nfoExportCommandAdapter = createTypedIpcAdapter<NfoExportIpcContract>(
  nfoExportIpcSchemas
)
export const nfoExportEventAdapter = createTypedEventAdapter<NfoExportIpcEventContract>()
