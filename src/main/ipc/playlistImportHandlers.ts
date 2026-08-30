import { IPC } from '@shared/ipc-channels'
import { createPlaylistImportModule } from '../services/playlistImport/playlistImportModule'
import { appCommandAdapter, appEventAdapter } from './appContractAdapter'
import type { IpcContext } from './shared'

export function registerPlaylistImportHandlers(ctx: IpcContext): void {
  const modulePromise = createPlaylistImportModule()
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

  appCommandAdapter.register(IPC.PLAYLIST_IMPORT_START, async (input) =>
    (await modulePromise).start(input)
  )
  appCommandAdapter.register(IPC.PLAYLIST_IMPORT_SNAPSHOT, async (runId) =>
    (await modulePromise).snapshot(runId)
  )
  appCommandAdapter.register(IPC.PLAYLIST_IMPORT_CONTROL, async (runId, command) =>
    (await modulePromise).control(runId, command)
  )
}
