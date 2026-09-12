import type { IpcMainInvokeEvent } from 'electron'
import type { IpcChannel } from '@shared/ipc-channels'
import type { MediaLibraryIpcContract } from '@shared/mediaLibraryIpcContract'
import { createTypedIpcAdapter } from './typedIpcAdapter'
import { mediaLibraryIpcSchemas } from './mediaLibraryIpcSchemas'

type HandlerRegistrar = (
  channel: IpcChannel,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>
) => void

export function createMediaLibraryCommandAdapter(register?: HandlerRegistrar):
  ReturnType<typeof createTypedIpcAdapter<MediaLibraryIpcContract>> {
  return createTypedIpcAdapter<MediaLibraryIpcContract>(mediaLibraryIpcSchemas, register)
}

export type MediaLibraryCommandAdapter = ReturnType<
  typeof createMediaLibraryCommandAdapter
>

export const mediaLibraryCommandAdapter = createMediaLibraryCommandAdapter()
