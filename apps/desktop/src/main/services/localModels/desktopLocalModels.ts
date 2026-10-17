import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { IPC } from '@shared/ipc-channels'
import type { LocalTranslationMode } from '@shared/desktop/localModels'
import { appEventAdapter } from '../../ipc/appContractAdapter'
import { createLocalModelManager } from './localModelManager'

let manager: ReturnType<typeof createLocalModelManager> | null = null
let initialTextTranslationMode: LocalTranslationMode | undefined

/** Capture before cloud bootstrap can create a document for a genuinely new profile. */
export function captureInitialLocalModelMode(): void {
  initialTextTranslationMode ??= existsSync(path.join(app.getPath('userData'), 'ai-configuration.json')) ? 'app-default' : 'local'
}

export function getLocalModels(): ReturnType<typeof createLocalModelManager> {
  if (!manager) {
    captureInitialLocalModelMode()
    const instance = createLocalModelManager(app.getPath('userData'), {
      initialTextTranslationMode,
      bundleRoot: app.isPackaged ? path.join(process.resourcesPath, 'ai-runtime') : path.join(app.getAppPath(), 'out/ai-runtime')
    })
    manager = instance
    let notificationFailed = false
    instance.onChanged(() => {
      void instance.snapshot().then(snapshot => {
        notificationFailed = false
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) appEventAdapter.send(window.webContents, IPC.LOCAL_MODELS_CHANGED, snapshot)
        }
      }).catch(() => {
        // The explicit snapshot/command IPC returns the readable error. Keep
        // the renderer's last valid state and never leak a rejected broadcast.
        if (!notificationFailed) console.warn('[local-models] unable to refresh model state')
        notificationFailed = true
      })
    })
  }
  return manager
}
export async function closeLocalModels(): Promise<void> { await manager?.close(); manager = null }
