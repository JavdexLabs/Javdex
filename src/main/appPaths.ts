import { app } from 'electron'
import path from 'node:path'
import { APP_DISPLAY_NAME, APP_PACKAGE_NAME } from '@shared/appIdentity'

/** Configure display name and userData before the app becomes ready. */
export function configureAppIdentity(): void {
  app.setName(APP_DISPLAY_NAME)
  const userDataName = process.env.JAVDEX_DEMO_MODE === '1' ? `${APP_PACKAGE_NAME} Demo` : APP_PACKAGE_NAME
  app.setPath('userData', path.join(app.getPath('appData'), userDataName))
}
