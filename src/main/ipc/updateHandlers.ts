import { IPC } from '@shared/ipc-channels'
import {
  checkForLatestRelease,
  getUpdateCheckState,
  ignoreUpdateVersion,
  openProjectPage,
  openReleasePage,
  onUpdateCheckStateChanged
} from '../services/appReleaseService'
import { openExternalLink } from '../services/externalLinkService'
import type { ProjectPage } from '@shared/updateTypes'
import type { IpcContext } from './shared'
import { appCommandAdapter, appEventAdapter } from './appContractAdapter'

export function registerUpdateHandlers(ctx: IpcContext): void {
  appCommandAdapter.register(IPC.APP_UPDATE_GET_STATE, () => getUpdateCheckState())
  appCommandAdapter.register(IPC.APP_UPDATE_CHECK, () => checkForLatestRelease())
  appCommandAdapter.register(IPC.APP_UPDATE_OPEN_RELEASE, () => openReleasePage())
  appCommandAdapter.register(IPC.APP_UPDATE_OPEN_PROJECT_PAGE, (page) =>
    openProjectPage(page)
  )
  appCommandAdapter.register(IPC.EXTERNAL_LINK_OPEN, (url) => openExternalLink(url))
  appCommandAdapter.register(IPC.APP_UPDATE_IGNORE_VERSION, (version) =>
    ignoreUpdateVersion(version)
  )
  onUpdateCheckStateChanged((state) => {
    appEventAdapter.send(ctx.getWindow()?.webContents, IPC.APP_UPDATE_STATE_CHANGED, state)
  })
}
