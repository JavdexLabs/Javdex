import type Database from 'better-sqlite3'
import { AgentMetadataDraftRepo } from '@library/db/agentMetadataDraftRepo'
import { mediaAssetStore } from '@library/mediaAssetStore'
import { AgentMetadataApplyCommit } from './draftApplyCommit'

let workDatabase: Database.Database | null = null
let applyCommit: AgentMetadataApplyCommit | null = null

export const desktopAgentDraftRepo = new AgentMetadataDraftRepo(() => {
  if (!workDatabase) throw new Error('Agent draft work database is not configured')
  return workDatabase
})

export function configureDesktopDraftStore(work: Database.Database, catalog?: Database.Database): void {
  workDatabase = work
  applyCommit = catalog ? new AgentMetadataApplyCommit(work, catalog) : null
}

export function clearDesktopDraftStore(): void {
  workDatabase = null
  applyCommit = null
}

export function desktopDraftApplyCommit(): AgentMetadataApplyCommit | undefined {
  if (!workDatabase) throw new Error('Agent draft work database is not configured')
  return applyCommit ?? undefined
}

export function recoverDesktopDraftCommits(): number {
  return applyCommit?.recoverCommitted(({ kind, stagedPaths }) => {
    if (kind === 'video') mediaAssetStore.cleanupVideoScrapeStagingPaths(stagedPaths)
    else mediaAssetStore.cleanupActressScrapeStagingPaths(stagedPaths)
  }) ?? 0
}
