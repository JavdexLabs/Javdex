import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { IpcChannel } from '@shared/ipc-channels'
import type { IpcResponse } from '@shared/ipcTypes'
import { toStructuredError } from '@shared/protocol/errors'
import { assertTrustedIpcSender } from './ipcSecurity'

export interface IpcContext {
  getWindow: () => BrowserWindow | null
}

function ok<T>(data: T): IpcResponse<T> {
  return { ok: true, data }
}

function fail<T>(error: unknown): IpcResponse<T> {
  return { ok: false, error: toStructuredError(error) }
}

export async function executeIpcHandler<Args extends unknown[], Result>(
  handler: (...args: Args) => Result | Promise<Result>,
  args: Args
): Promise<IpcResponse<Awaited<Result>>> {
  try {
    return ok(await handler(...args) as Awaited<Result>)
  } catch (error) {
    return fail(error)
  }
}

export function registerHandler<Args extends unknown[], Result>(
  channel: IpcChannel,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>
): void {
  ipcMain.handle(channel, (event, ...args) =>
    executeIpcHandler(
      (trustedEvent: IpcMainInvokeEvent, ...trustedArgs: Args) => {
        assertTrustedIpcSender(trustedEvent)
        return handler(trustedEvent, ...trustedArgs)
      },
      [event, ...(args as Args)]
    )
  )
}
