import type { WebContents } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { PlaylistImportModule } from '@shared/playlistImportTypes'
import { createPlaylistImportModule } from '../services/playlistImport/playlistImportModule'
import { appCommandAdapter, appEventAdapter } from './appContractAdapter'
import type { IpcContext } from './shared'

const TERMINAL_PHASES = new Set(['completed', 'failed', 'cancelled'])

export async function cancelForegroundPlaylistImport(
  module: Pick<PlaylistImportModule, 'snapshot' | 'control'>
): Promise<void> {
  const snapshot = module.snapshot()
  if (!snapshot || TERMINAL_PHASES.has(snapshot.phase)) return
  await module.control(snapshot.runId, {
    kind: 'cancel',
    idempotencyKey: `renderer-disconnected:${snapshot.runId}:${snapshot.revision}`
  })
}

export function bindPlaylistImportRendererLifecycle(
  webContents: WebContents | undefined,
  boundOwners: WeakSet<WebContents>,
  rendererDisconnected: () => void
): void {
  if (!webContents || boundOwners.has(webContents)) return
  boundOwners.add(webContents)
  webContents.on('render-process-gone', rendererDisconnected)
  webContents.on('destroyed', rendererDisconnected)
  webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) rendererDisconnected()
  })
}

export function registerPlaylistImportHandlers(ctx: IpcContext): void {
  const modulePromise = createPlaylistImportModule()
  const boundOwners = new WeakSet<WebContents>()
  let disconnectCancellation = Promise.resolve()
  const rendererDisconnected = (): void => {
    disconnectCancellation = disconnectCancellation
      .then(() => modulePromise)
      .then(cancelForegroundPlaylistImport)
      .catch((error) => {
        console.error('Failed to cancel foreground playlist import:', error)
      })
  }
  const bindCurrentRenderer = (): void => bindPlaylistImportRendererLifecycle(
    ctx.getWindow()?.webContents,
    boundOwners,
    rendererDisconnected
  )
  bindCurrentRenderer()
  void modulePromise.then((module) => {
    module.subscribe((event) => {
      appEventAdapter.send(
        ctx.getWindow()?.webContents,
        IPC.PLAYLIST_IMPORT_SNAPSHOT_CHANGED,
        event
      )
    })
  }).catch((error) => {
    console.error('Failed to initialize PlaylistImportModule:', error)
  })

  appCommandAdapter.register(IPC.PLAYLIST_IMPORT_START, async (input) => {
    // macOS can recreate the main window without registering IPC handlers again.
    bindCurrentRenderer()
    return (await modulePromise).start(input)
  })
  appCommandAdapter.register(IPC.PLAYLIST_IMPORT_SNAPSHOT, async (runId) =>
    (await modulePromise).snapshot(runId)
  )
  appCommandAdapter.register(IPC.PLAYLIST_IMPORT_CONTROL, async (runId, command) =>
    (await modulePromise).control(runId, command)
  )
}
