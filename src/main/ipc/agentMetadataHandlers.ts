import { IPC } from '@shared/ipc-channels'
import { agentMetadataCollection } from '../services/agentMetadata/agentMetadataCollection'
import type { IpcContext } from './shared'
import { appCommandAdapter, appEventAdapter } from './appContractAdapter'

export function registerAgentMetadataHandlers(ctx: IpcContext): void {
  agentMetadataCollection.subscribe((event) => {
    appEventAdapter.send(
      ctx.getWindow()?.webContents,
      IPC.AGENT_METADATA_SNAPSHOT_CHANGED,
      event
    )
  })
  appCommandAdapter.register(IPC.AGENT_METADATA_START, (input) =>
    agentMetadataCollection.start(input)
  )
  appCommandAdapter.register(IPC.AGENT_METADATA_RESUME, (input) =>
    agentMetadataCollection.resume(input)
  )
  appCommandAdapter.register(IPC.AGENT_METADATA_CANCEL, (runId) =>
    agentMetadataCollection.cancel(runId)
  )
  appCommandAdapter.register(IPC.AGENT_METADATA_SNAPSHOT, (runId) =>
    agentMetadataCollection.snapshot(runId)
  )
  appCommandAdapter.register(IPC.AGENT_METADATA_FIND_READY, (target) =>
    agentMetadataCollection.findReady(target)
  )
  appCommandAdapter.register(IPC.AGENT_METADATA_PLAN, (input) =>
    agentMetadataCollection.plan(input)
  )
  appCommandAdapter.register(IPC.AGENT_METADATA_APPLY, (input) =>
    agentMetadataCollection.apply(input)
  )
  appCommandAdapter.register(IPC.AGENT_METADATA_DISCARD, (input) =>
    agentMetadataCollection.discard(input)
  )
}

