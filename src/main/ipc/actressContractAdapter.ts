import type {
  ActressIpcArgs,
  ActressIpcChannel,
  ActressIpcEvent,
  ActressIpcEventChannel,
  ActressIpcResult
} from '@shared/actressIpcContract'
import { createTypedEventAdapter, createTypedIpcAdapter } from './typedIpcAdapter'
import type { ActressIpcContract, ActressIpcEventContract } from '@shared/actressIpcContract'
import type { WebContents } from 'electron'

const commandAdapter = createTypedIpcAdapter<ActressIpcContract>()
const eventAdapter = createTypedEventAdapter<ActressIpcEventContract>()

export function registerActressHandler<Channel extends ActressIpcChannel>(
  channel: Channel,
  handler: (
    ...args: ActressIpcArgs<Channel>
  ) => ActressIpcResult<Channel> | Promise<ActressIpcResult<Channel>>
): void {
  commandAdapter.register(channel, handler)
}

export function sendActressEvent<Channel extends ActressIpcEventChannel>(
  webContents: Pick<WebContents, 'send'> | undefined,
  channel: Channel,
  payload: ActressIpcEvent<Channel>
): void {
  eventAdapter.send(webContents, channel, payload)
}
