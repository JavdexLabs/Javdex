import { createVideoLifecycleService } from '@library/catalog/videoLifecycleService'
import { desktopAgentDraftRepo, completeDesktopVideoDraftCleanup, assertDesktopVideoDraftsMutable } from './agentMetadata/desktopDraftStore'

export * from '@library/catalog/videoLifecycleService'

export const videoLifecycleService = createVideoLifecycleService({
  workDrafts: desktopAgentDraftRepo,
  completeWorkDraftCleanup: completeDesktopVideoDraftCleanup,
  assertWorkDraftsMutable: assertDesktopVideoDraftsMutable
})
