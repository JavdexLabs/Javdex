import { z } from 'zod'
import { IPC } from '@shared/ipc-channels'
import { NFO_EXPORT_PROFILE_IDS } from '@shared/nfoExportTypes'
import type { NfoExportIpcContract } from '@shared/nfoExportIpcContract'
import type { IpcArgsSchemaMap } from './typedIpcAdapter'

const preferences = z.object({
  libraryIds: z.array(z.number().int().positive()).max(100),
  profileId: z.enum(NFO_EXPORT_PROFILE_IDS),
  includeCover: z.boolean(),
  includeFanart: z.boolean(),
  includeSamples: z.boolean(),
  includeActorAvatars: z.boolean()
}).strict()

export const nfoExportIpcSchemas = {
  [IPC.NFO_EXPORT_GET_OPTIONS]: z.tuple([]),
  [IPC.NFO_EXPORT_UPDATE_PREFERENCES]: z.tuple([preferences]),
  [IPC.NFO_EXPORT_PLAN]: z.tuple([
    preferences.extend({ collisionPolicy: z.enum(['skip', 'replace']) }).strict()
  ]),
  [IPC.NFO_EXPORT_DISCARD_PLAN]: z.tuple([z.string().uuid()]),
  [IPC.NFO_EXPORT_START]: z.tuple([z.string().uuid()]),
  [IPC.NFO_EXPORT_TERMINATE]: z.tuple([z.string().uuid()])
} satisfies IpcArgsSchemaMap<NfoExportIpcContract>
