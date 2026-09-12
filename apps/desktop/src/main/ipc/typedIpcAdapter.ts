import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { z } from 'zod'
import type {
  IpcContractArgs,
  IpcContractChannel,
  IpcContractResult,
  IpcEventChannel,
  IpcEventPayload
} from '@shared/typedIpcContract'
import type { IpcChannel } from '@shared/ipc-channels'
import { DesktopIpcError, structuredError } from '@shared/protocol/errors'
import { registerHandler } from './shared'

type HandlerRegistrar = (
  channel: IpcChannel,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>
) => void

export type IpcArgsSchemaMap<Contract extends object> = {
  [Channel in IpcContractChannel<Contract>]: z.ZodType<unknown[]>
}

export function createTypedIpcAdapter<Contract extends object>(
  schemas: IpcArgsSchemaMap<Contract>,
  register: HandlerRegistrar = registerHandler
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
      register(channel, (_event, ...args) => {
        const parsed = schemas[channel].safeParse(args)
        if (!parsed.success) {
          const reason = parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '参数'}: ${issue.message}`)
            .join('；')
          throw new DesktopIpcError(
            structuredError(
              'INVALID_INPUT',
              `无效的 IPC 请求参数（${channel}）：${reason}`
            )
          )
        }
        return handler(...(parsed.data as IpcContractArgs<Contract, typeof channel>))
      })
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
