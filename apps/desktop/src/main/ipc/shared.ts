import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { isBackupMaintenanceActive } from '@library/catalog/catalogBackup'
import { IPC_DISPOSITION } from '@shared/inventory/ipcDisposition'
import { IPC } from '@shared/ipc-channels'
import type { IpcChannel } from '@shared/ipc-channels'
import type { IpcResponse } from '@shared/ipcTypes'
import { structuredError, toStructuredError } from '@shared/protocol/errors'
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
        if (isBackupMaintenanceActive() && channel !== IPC.BACKUP_CONTROL && channel !== IPC.BACKUP_FILE) {
          const key = (Object.keys(IPC) as Array<keyof typeof IPC>).find(key => IPC[key] === channel)
          const kind = key ? IPC_DISPOSITION[key].kind : null
          if (kind && !['manageQuery', 'desktopEvent', 'desktopRetain'].includes(kind)) {
            throw structuredError('MAINTENANCE_BUSY', '资料库正在备份或恢复，请等待操作完成')
          }
        }
        return handler(trustedEvent, ...trustedArgs)
      },
      [event, ...(args as Args)]
    )
  )
}
