import { IPC } from '@shared/ipc-channels'
import { libraryCurator } from '../services/libraryCuratorAgent/libraryCurator'
import { appCommandAdapter } from './appContractAdapter'

export function registerLibraryCuratorHandlers(): void {
  appCommandAdapter.register(
    IPC.LIBRARY_CURATOR_START,
    (input) => libraryCurator.start(input)
  )
  appCommandAdapter.register(
    IPC.LIBRARY_CURATOR_MESSAGE,
    (input) => libraryCurator.message(input)
  )
  appCommandAdapter.register(
    IPC.LIBRARY_CURATOR_CANCEL,
    (runId) => libraryCurator.cancel(runId)
  )
  appCommandAdapter.register(
    IPC.LIBRARY_CURATOR_SNAPSHOT,
    (runId) => libraryCurator.getSnapshot(runId)
  )
}
