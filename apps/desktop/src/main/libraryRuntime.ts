import { app } from 'electron'
import path from 'node:path'
import { configureLibraryHost } from '@library/runtime/host'
import { configureCatalogReadWorkerEntry } from './services/catalogReadService'

export function configureDesktopLibraryRuntime(): void {
  configureLibraryHost({
    userDataPath: () => app.getPath('userData')
  })
  configureCatalogReadWorkerEntry(path.join(app.getAppPath(), 'out/main/catalogReadWorker.js'))
}
