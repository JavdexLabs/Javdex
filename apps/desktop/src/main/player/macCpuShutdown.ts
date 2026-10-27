import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'

/** Wait for the owning renderer to retire the CPU video stream before app quit. */
export function retireMacCpuSurface(contents: WebContents, surfaceToken: string): Promise<void> {
  if (contents.isDestroyed() || !/^cpu:[\da-f-]{36}$/.test(surfaceToken)) return Promise.resolve()
  const requestId = randomUUID()
  return new Promise(resolve => {
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      ipcMain.removeListener('playback:cpu-shutdown-ready', ready)
      contents.removeListener('destroyed', finish)
      contents.removeListener('render-process-gone', finish)
      resolve()
    }
    const ready = (event: IpcMainEvent, value: unknown): void => {
      if (contents.isDestroyed() || event.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame) return
      const message = value as { requestId?: unknown; surfaceToken?: unknown } | null
      if (message?.requestId === requestId && message.surfaceToken === surfaceToken) finish()
    }
    // An already-gone or unresponsive renderer must not block app shutdown.
    const timer = setTimeout(finish, 2000)
    ipcMain.on('playback:cpu-shutdown-ready', ready)
    contents.once('destroyed', finish)
    contents.once('render-process-gone', finish)
    try { contents.send('playback:cpu-shutdown', { requestId, surfaceToken }) } catch { finish() }
  })
}
