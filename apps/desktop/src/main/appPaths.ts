import { app } from 'electron'
import path from 'node:path'
import {
  APP_DISPLAY_NAME,
  APP_PACKAGE_NAME,
  readTestUserDataPath
} from '@shared/appIdentity'

/** Configure display name and userData before the app becomes ready. */
export function configureAppIdentity(): void {
  app.setName(APP_DISPLAY_NAME)
  const testUserDataPath = readTestUserDataPath()
  app.setPath(
    'userData',
    testUserDataPath
      ? path.resolve(testUserDataPath)
      : path.join(app.getPath('appData'), APP_PACKAGE_NAME)
  )
}
