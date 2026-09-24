import type {
  ActressIpcArgs,
  ActressIpcChannel,
  ActressIpcResult
} from '@shared/actressIpcContract'
import { createTypedIpcAdapter } from './typedIpcAdapter'
import type { ActressIpcContract } from '@shared/actressIpcContract'
import { actressIpcSchemas } from './ipcCommandSchemas'

const commandAdapter = createTypedIpcAdapter<ActressIpcContract>(actressIpcSchemas)

export function registerActressHandler<Channel extends ActressIpcChannel>(
  channel: Channel,
  handler: (
    ...args: ActressIpcArgs<Channel>
  ) => ActressIpcResult<Channel> | Promise<ActressIpcResult<Channel>>
): void {
  commandAdapter.register(channel, handler)
}
