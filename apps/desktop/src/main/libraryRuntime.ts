import { app } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { readTestUserDataPath } from '@shared/appIdentity'
import { configureLibraryHost } from '@library/runtime/host'
import { createElectronImageCodec } from './nativeImageCodec'
import { configureCatalogReadWorkerEntry } from './services/catalogReadService'

export function configureDesktopLibraryRuntime(): void {
  configureLibraryHost({
    userDataPath: () => app.getPath('userData'),
    images: createElectronImageCodec()
  })
  configureCatalogReadWorkerEntry(path.join(app.getAppPath(), 'out/main/catalogReadWorker.js'))
}

export function configureDesktopLibraryTestRuntime(): void {
  configureLibraryHost({
    userDataPath: () =>
      readTestUserDataPath() ?? path.join(os.tmpdir(), 'Javdex-test-user-data'),
    images: createElectronImageCodec()
  })
}

