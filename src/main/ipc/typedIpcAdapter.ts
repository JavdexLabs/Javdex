import type { WebContents } from 'electron'
import type {
  IpcContractArgs,
  IpcContractChannel,
  IpcContractResult,
  IpcEventChannel,
  IpcEventPayload
} from '@shared/typedIpcContract'
import type { IpcChannel } from '@shared/ipc-channels'
import { registerHandler } from './shared'

type HandlerRegistrar = (
  channel: IpcChannel,
  handler: (...args: unknown[]) => unknown | Promise<unknown>
) => void

const registerWithoutEvent: HandlerRegistrar = (channel, handler) => {
  registerHandler(channel, (_event, ...args) => handler(...args))
}

export function createTypedIpcAdapter<Contract extends object>(
  register: HandlerRegistrar = registerWithoutEvent
): {
  register<Channel extends IpcContractChannel<Contract> & IpcChannel>(
    channel: Channel,
    handler: (
      ...args: IpcContractArgs<Contract, Channel>
    ) =>
      | IpcContractResult<Contract, Channel>
      | Promise<IpcContractResult<Contract, Channel>>
  ): void
} {
  return {
    register(channel, handler): void {
      register(
        channel,
        handler as (...args: unknown[]) => unknown | Promise<unknown>
      )
    }
  }
}

export function createTypedEventAdapter<Contract extends object>(): {
  send<Channel extends IpcEventChannel<Contract> & IpcChannel>(
    webContents: Pick<WebContents, 'send'> | undefined,
    channel: Channel,
    payload: IpcEventPayload<Contract, Channel>
  ): void
} {
  return {
    send(webContents, channel, payload): void {
      webContents?.send(channel, payload)
    }
  }
}
