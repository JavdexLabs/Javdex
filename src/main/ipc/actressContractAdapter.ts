import type { WebContents } from 'electron'
import type {
  ActressIpcArgs,
  ActressIpcChannel,
  ActressIpcEvent,
  ActressIpcEventChannel,
  ActressIpcResult
} from '@shared/actressIpcContract'
import { registerHandler } from './shared'

export function registerActressHandler<Channel extends ActressIpcChannel>(
  channel: Channel,
  handler: (
    ...args: ActressIpcArgs<Channel>
  ) => ActressIpcResult<Channel> | Promise<ActressIpcResult<Channel>>
): void {
  registerHandler(channel, (_event, ...args: ActressIpcArgs<Channel>) => handler(...args))
}

export function sendActressEvent<Channel extends ActressIpcEventChannel>(
  webContents: Pick<WebContents, 'send'> | undefined,
  channel: Channel,
  payload: ActressIpcEvent<Channel>
): void {
  webContents?.send(channel, payload)
}
