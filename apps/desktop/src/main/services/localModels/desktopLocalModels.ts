import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { IPC } from '@shared/ipc-channels'
import { appEventAdapter } from '../../ipc/appContractAdapter'
import { createLocalModelManager } from './localModelManager'

let manager: ReturnType<typeof createLocalModelManager> | null = null
export function getLocalModels(): ReturnType<typeof createLocalModelManager> {
  if (!manager) {
    const instance = createLocalModelManager(app.getPath('userData'), {
      bundleRoot: app.isPackaged ? path.join(process.resourcesPath, 'ai-runtime') : path.join(app.getAppPath(), 'out/ai-runtime')
    })
    manager = instance
    instance.onChanged(() => {
      void instance.snapshot().then(snapshot => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) appEventAdapter.send(window.webContents, IPC.LOCAL_MODELS_CHANGED, snapshot)
        }
      })
    })
  }
  return manager
}
export async function closeLocalModels(): Promise<void> { await manager?.close(); manager = null }
