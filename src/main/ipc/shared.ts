import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { IpcChannel } from '@shared/ipc-channels'
import type { IpcResponse } from '@shared/types'

export interface IpcContext {
  getWindow: () => BrowserWindow | null
}

function ok<T>(data: T): IpcResponse<T> {
  return { ok: true, data }
}

function fail<T>(error: unknown): IpcResponse<T> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

export function registerHandler<Args extends unknown[], Result>(
  channel: IpcChannel,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>
): void {
  ipcMain.handle(channel, async (event, ...args): Promise<IpcResponse<Awaited<Result>>> => {
    try {
      const data = await handler(event, ...(args as Args))
      return ok(data as Awaited<Result>)
    } catch (e) {
      return fail(e)
    }
  })
}
