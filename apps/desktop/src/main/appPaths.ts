import { app } from 'electron'
import path from 'node:path'
import { EXPERIMENTAL_LINUX_NAME, EXPERIMENTAL_LINUX_PROFILE, isExperimentalLinuxBuild } from './experimentalLinuxBuild'
import {
  APP_DISPLAY_NAME,
  APP_PACKAGE_NAME,
  readTestUserDataPath
} from '@shared/appIdentity'

/** Configure display name and userData before the app becomes ready. */
export function configureAppIdentity(): void {
  const experimental = isExperimentalLinuxBuild()
  const portable = experimental && isExperimentalLinuxBuild('javdex-linux-portable-phase1')
  app.setName(portable ? 'Javdex Linux Portable Phase1' : experimental ? EXPERIMENTAL_LINUX_NAME : APP_DISPLAY_NAME)
  const testUserDataPath = readTestUserDataPath()
  app.setPath(
    'userData',
    testUserDataPath
      ? path.resolve(testUserDataPath)
      : path.join(app.getPath('appData'), portable ? 'Javdex-Linux-Portable-Phase1' : experimental ? EXPERIMENTAL_LINUX_PROFILE : APP_PACKAGE_NAME)
  )
}
