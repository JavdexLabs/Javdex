import type Database from 'better-sqlite3'
import { AgentMetadataDraftRepo } from '@library/db/agentMetadataDraftRepo'
import { mediaAssetStore } from '@library/mediaAssetStore'
import { AgentMetadataApplyCommit } from './draftApplyCommit'
import type { DeleteVideoGloballyRepoResult } from '@library/db/videoLifecycleRepo'
import { readCatalogIdentity } from '@library/catalog/catalogIdentity'
import { applyAgentMetadataDraftToCatalog, findReadyAgentMetadata } from '@library/catalog/catalogAgentMetadata'
import type { CatalogAgentMetadataCommands } from '../../application/catalogBackend'
import type { AgentMetadataApplyInput } from '@shared/agentMetadataTypes'
import { AgentMetadataDiscardCommit } from './draftDiscardCommit'

let workDatabase: Database.Database | null = null
let applyCommit: AgentMetadataApplyCommit | null = null
let catalogDatabase: Database.Database | null = null
let discardCommit: AgentMetadataDiscardCommit | null = null

export const desktopAgentDraftRepo = new AgentMetadataDraftRepo(() => {
  if (!workDatabase) throw new Error('Agent draft work database is not configured')
  return workDatabase
})

export function configureDesktopDraftStore(work: Database.Database, catalog?: Database.Database): void {
  workDatabase = work
  catalogDatabase = catalog ?? null
  applyCommit = catalog ? new AgentMetadataApplyCommit(work, catalog) : null
  discardCommit = catalog && applyCommit ? new AgentMetadataDiscardCommit(work, catalog, applyCommit) : null
}

export function clearDesktopDraftStore(): void {
  workDatabase = null
  catalogDatabase = null
  applyCommit = null
  discardCommit = null
}

export function desktopDraftApplyCommit(): AgentMetadataApplyCommit | undefined {
  if (!workDatabase) throw new Error('Agent draft work database is not configured')
  return applyCommit ?? undefined
}

export function findReadyDesktopManagedDraft(...[input]: Parameters<CatalogAgentMetadataCommands['findReady']>) {
  if (!catalogDatabase) throw new Error('Local draft catalog is not configured')
  return findReadyAgentMetadata(input.target, catalogDatabase, desktopAgentDraftRepo)
}

export function applyDesktopManagedDraft(...[input, ctx]: Parameters<CatalogAgentMetadataCommands['apply']>) {
  if (!catalogDatabase || !applyCommit) throw new Error('Local draft catalog is not configured')
  const database = catalogDatabase
  return applyCommit.apply({ draftId: input.draftId, reviewToken: input.reviewToken, idempotencyKey: ctx.operationId }, () => {
    const draft = desktopAgentDraftRepo.require(input.draftId)
    const outcome = applyAgentMetadataDraftToCatalog({ ...input, database,
      expected: ctx.expectedVersions, operationId: ctx.operationId }, desktopAgentDraftRepo)
    return { outcome, versions: outcome.versions,
      cleanup: { kind: draft.target.kind, stagedPaths: draft.resources.map(resource => resource.stagedPath) } }
  }, ({ kind, stagedPaths }) => {
    if (kind === 'video') mediaAssetStore.cleanupVideoScrapeStagingPaths(stagedPaths)
    else mediaAssetStore.cleanupActressScrapeStagingPaths(stagedPaths)
  }, { operationId: ctx.operationId, operation: 'agentMetadata.apply', input,
    expectedVersions: ctx.expectedVersions, writerEpoch: 0 })
}

export function resumeDesktopManagedDraft(input: AgentMetadataApplyInput) {
  if (!applyCommit) throw new Error('Local draft catalog is not configured')
  return applyCommit.resume(input, ({ kind, stagedPaths }) => {
    if (kind === 'video') mediaAssetStore.cleanupVideoScrapeStagingPaths(stagedPaths)
    else mediaAssetStore.cleanupActressScrapeStagingPaths(stagedPaths)
  })
}

export function discardDesktopManagedDraft(...[input, ctx]: Parameters<CatalogAgentMetadataCommands['discard']>) {
  if (!discardCommit) throw new Error('Local draft catalog is not configured')
  return discardCommit.discard(input.draftId, { operationId: ctx.operationId, operation: 'agentMetadata.discard',
    input, expectedVersions: ctx.expectedVersions, writerEpoch: 0 }, cleanupDraftStaging)
}

function cleanupDraftStaging(kind: 'video' | 'actress', paths: string[]): void {
  if (kind === 'video') mediaAssetStore.cleanupVideoScrapeStagingPaths(paths)
  else mediaAssetStore.cleanupActressScrapeStagingPaths(paths)
}

export function recoverDesktopDraftDiscards(): void {
  discardCommit?.recoverCommitted(cleanupDraftStaging)
}

export function recoverDesktopDraftCommits(): number {
  return applyCommit?.recoverCommitted(({ kind, stagedPaths }) => {
    if (kind === 'video') mediaAssetStore.cleanupVideoScrapeStagingPaths(stagedPaths)
    else mediaAssetStore.cleanupActressScrapeStagingPaths(stagedPaths)
  }) ?? 0
}

export function completeDesktopVideoDraftCleanup(result: DeleteVideoGloballyRepoResult): void {
  if (!workDatabase || !catalogDatabase) throw new Error('Local draft cleanup is not configured')
  const identity = readCatalogIdentity(catalogDatabase)
  if (!identity || !result.agentDraftWorkStoreCleanup || !result.agentDraftCleanup) {
    throw new Error('影片删除缺少资料库身份或工作清理快照')
  }
  if (result.agentDraftCleanupCatalogId !== identity.catalogId) {
    throw new Error('影片删除回执不属于当前资料库，不能清理工作草稿')
  }
  const done = workDatabase.prepare('SELECT 1 FROM agent_video_delete_cleanups WHERE catalog_id=? AND operation_id=?')
    .get(identity.catalogId, result.operationId)
  if (done) return
  desktopAgentDraftRepo.deleteLifecycleSnapshot({ kind: 'video', id: result.videoId }, result.agentDraftCleanup)
  mediaAssetStore.cleanupVideoScrapeStagingPaths(result.pendingStagingPaths)
  workDatabase.prepare('INSERT INTO agent_video_delete_cleanups(catalog_id,operation_id) VALUES(?,?)')
    .run(identity.catalogId, result.operationId)
}

export function assertDesktopVideoDraftsMutable(videoId: number): void {
  if (!applyCommit) throw new Error('Local draft cleanup is not configured')
  for (const draft of desktopAgentDraftRepo.lifecycleSnapshot({ kind: 'video', id: videoId }).drafts) {
    applyCommit.assertMutable(draft.id)
  }
}

export function recoverDesktopVideoDraftCleanups(): void {
  if (!catalogDatabase) return
  const identity = readCatalogIdentity(catalogDatabase)
  if (!identity) throw new Error('影片删除恢复缺少资料库身份')
  const rows = catalogDatabase.prepare("SELECT result_json FROM video_lifecycle_operations WHERE kind='delete-globally'")
    .all() as Array<{ result_json: string }>
  for (const row of rows) {
    const result = JSON.parse(row.result_json) as DeleteVideoGloballyRepoResult
    if (result.agentDraftWorkStoreCleanup && result.agentDraftCleanupCatalogId === identity.catalogId) {
      completeDesktopVideoDraftCleanup(result)
    }
  }
}
