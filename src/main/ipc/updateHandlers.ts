import { IPC } from '@shared/ipc-channels'
import {
  checkForLatestRelease,
  getUpdateCheckState,
  ignoreUpdateVersion,
  openExternalReleaseLink,
  openProjectPage,
  openReleasePage,
  onUpdateCheckStateChanged,
  type ProjectPage
} from '../services/appReleaseService'
import type { IpcContext } from './shared'
import { registerHandler } from './shared'

export function registerUpdateHandlers(ctx: IpcContext): void {
  registerHandler(IPC.APP_UPDATE_GET_STATE, () => getUpdateCheckState())
  registerHandler(IPC.APP_UPDATE_CHECK, () => checkForLatestRelease())
  registerHandler(IPC.APP_UPDATE_OPEN_RELEASE, () => openReleasePage())
  registerHandler(IPC.APP_UPDATE_OPEN_PROJECT_PAGE, (_event, page: ProjectPage) =>
    openProjectPage(page)
  )
  registerHandler(IPC.APP_UPDATE_OPEN_EXTERNAL_LINK, (_event, url: string) =>
    openExternalReleaseLink(url)
  )
  registerHandler(IPC.APP_UPDATE_IGNORE_VERSION, (_event, version: string) =>
    ignoreUpdateVersion(version)
  )
  onUpdateCheckStateChanged((state) => {
    ctx.getWindow()?.webContents.send(IPC.APP_UPDATE_STATE_CHANGED, state)
  })
}
