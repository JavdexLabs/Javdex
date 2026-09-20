import type Database from 'better-sqlite3'
import type {
  AgentMetadataApplyOutcome,
  AgentMetadataDraft,
  AgentMetadataTarget
} from '@shared/agentMetadataTypes'
import type { CatalogImageRef } from '@shared/protocol/uploads'
import type { ExpectedVersions } from '@shared/protocol/versions'
import { structuredError } from '@shared/protocol/errors'
import { getDb } from '@library/db/database'
import { getVideoById } from '@library/db/videoRepo'
import { getActressDetail } from '@library/db/actressRepo'
import { AgentMetadataDraftRepo } from '@library/db/agentMetadataDraftRepo'
import { mediaAssetStore } from '@library/mediaAssetStore'
import { applyScrapeResult } from '@library/catalog/videoScrapeApplyService'
import { applyActressScrapeResult } from '@library/catalog/actressAssetService'
import {
  assertExpectedActressVersion,
  assertExpectedVideoVersion,
  bumpRowRevision,
  readActressAggregateVersion,
  readVideoAggregateVersion
} from '@library/catalog/catalogAggregateVersion'
import { applyActressScrapeCandidate, applyVideoScrapeCandidate } from '@library/catalog/catalogScrapeApply'

export function findReadyAgentMetadata(
  target: AgentMetadataTarget,
  database: Database.Database = getDb(),
  repo: AgentMetadataDraftRepo = new AgentMetadataDraftRepo(() => database)
): {
  draft: AgentMetadataDraft | null
  versions: ExpectedVersions
} {
  const draft = repo.findReadyForTarget(target)
  const versions: ExpectedVersions = {}
  if (target.kind === 'video') {
    const version = readVideoAggregateVersion(target.id, database)
    if (version) versions.V = version
  } else {
    const version = readActressAggregateVersion(target.id, database)
    if (version) versions.A = version
  }
  return { draft, versions }
}

export function discardAgentMetadataDraft(
  draftId: string,
  expectedRevision: number,
  database: Database.Database = getDb()
): { ok: boolean } {
  const repo = new AgentMetadataDraftRepo(() => database)
  const draft = repo.get(draftId)
  if (!draft) throw structuredError('INVALID_INPUT', 'Agent 元数据草稿不存在', { field: 'draftId' })
  if (draft.revision !== expectedRevision) {
    throw structuredError('VERSION_CONFLICT', '草稿已更新，无法按旧版本丢弃。', { field: 'expectedVersions.Q' })
  }
  const discarded = repo.discard({ draftId, expectedRevision })
  try {
    if (draft.target.kind === 'video') mediaAssetStore.cleanupVideoScrapeStagingPaths(discarded.stagedPaths)
    else mediaAssetStore.cleanupActressScrapeStagingPaths(discarded.stagedPaths)
  } catch (error) {
    console.error('Agent metadata staging cleanup failed:', error)
  }
  return { ok: true }
}

export interface AgentMetadataCatalogApplyInput {
  draftId: string
  reviewToken: string
  uploads?: CatalogImageRef[]
  expected: ExpectedVersions
  operationId: string
  database?: Database.Database
}

type CatalogDraftOutcome = Exclude<AgentMetadataApplyOutcome, { status: 'preview_stale' }> & { versions?: ExpectedVersions }

/** Same-store host: the caller owns the catalog transaction and receipt. */
export function applyAgentMetadataDraft(input: AgentMetadataCatalogApplyInput): CatalogDraftOutcome {
  const database = input.database ?? getDb()
  const repo = new AgentMetadataDraftRepo(() => database)
  const replay = repo.getStoredOutcome({ draftId: input.draftId, idempotencyKey: input.operationId })
  if (replay && replay.status !== 'preview_stale') return replay
  const draft = repo.require(input.draftId)
  const result = applyAgentMetadataDraftToCatalog({ ...input, database }, repo)
  repo.completeApply({ draftId: input.draftId, reviewToken: input.reviewToken,
    idempotencyKey: input.operationId, outcome: result })
  const paths = draft.resources.map(resource => resource.stagedPath)
  if (draft.target.kind === 'video') mediaAssetStore.cleanupVideoScrapeStagingPaths(paths)
  else mediaAssetStore.cleanupActressScrapeStagingPaths(paths)
  return result
}

/** Applies only formal catalog data; the host completes the explicit draft store after commit. */
export function applyAgentMetadataDraftToCatalog(
  input: AgentMetadataCatalogApplyInput,
  repo: AgentMetadataDraftRepo
): CatalogDraftOutcome {
  const database = input.database ?? getDb()
  const draft = repo.require(input.draftId)
  const stored = repo.getStoredReview(input.draftId)
  if (draft.status !== 'ready' || !stored || stored.token !== input.reviewToken) {
    throw structuredError('VERSION_CONFLICT', '预览已过期，请重新检查后再应用。', { field: 'reviewToken' }, input.operationId)
  }
  if (!stored.canApply) {
    throw structuredError('INVALID_INPUT', '当前预览仍有必须处理的问题。', { field: 'reviewToken' }, input.operationId)
  }
  const expectedQ = input.expected.Q
  if (!expectedQ || expectedQ.revision !== draft.revision) {
    throw structuredError(
      'VERSION_CONFLICT',
      '草稿已变化，请刷新后重新应用',
      { field: 'expectedVersions.Q' },
      input.operationId
    )
  }

  if (draft.target.kind === 'video') {
    assertExpectedVideoVersion(draft.target.id, input.expected, input.operationId, database)
    const video = getVideoById(draft.target.id, database)
    if (!video) throw structuredError('INVALID_INPUT', '影片不存在', { entityKind: 'video', entityId: draft.target.id }, input.operationId)
    if (stored.kind !== 'video' || draft.payload.kind !== 'video') {
      throw structuredError('INVALID_INPUT', '影片草稿类型无效', { field: 'draftId' }, input.operationId)
    }
    if (input.uploads?.length) {
      const [cover, ...samples] = input.uploads
      const applied = applyVideoScrapeCandidate({
        videoId: draft.target.id,
        fields: stored.selection.fields,
        mode: stored.selection.mode,
        candidate: draft.payload.result,
        cover,
        samples,
        expected: input.expected,
        operationId: input.operationId,
        database
      })
      const outcome: AgentMetadataApplyOutcome = {
        status: applied.applied ? 'applied' : 'no_op',
        target: draft.target,
        warnings: [...draft.warnings, ...applied.warnings]
      }
      return { ...outcome, versions: applied.versions }
    }
    const fields = new Set(stored.selection.fields)
    const coverResource = fields.has('cover')
      ? draft.resources.find((item) => item.field === 'cover')
      : undefined
    const coverPath = coverResource
      ? mediaAssetStore.importCover(video.code, mediaAssetStore.resolve(coverResource.stagedPath))
      : null
    const sampleResources = draft.resources
      .filter((item) => item.field === 'samples')
      .sort((left, right) => left.position - right.position)
    const samplePaths =
      fields.has('samples') && sampleResources.length === (draft.payload.result.sampleImageUrls?.length ?? 0)
        ? sampleResources.map((item) => mediaAssetStore.importSample(video.code, mediaAssetStore.resolve(item.stagedPath)))
        : (draft.payload.result.sampleImageUrls ?? []).map(() => null)
    const applied = applyScrapeResult(
      draft.target.id,
      draft.payload.result,
      coverPath,
      new Map(),
      samplePaths,
      stored.selection.fields,
      draft.source.sourceName,
      stored.selection.mode,
      draft.source.sourceName,
      { directorSelectionId: stored.selection.directorSelectionId, directorAmbiguity: 'choice' }
    )
    if (applied.applied) bumpRowRevision('videos', draft.target.id, database)
    const outcome: AgentMetadataApplyOutcome = {
      status: applied.applied ? 'applied' : 'no_op',
      target: draft.target,
      warnings: [...draft.warnings, ...applied.warnings]
    }
    return { ...outcome, versions: { V: readVideoAggregateVersion(draft.target.id, database)! } }
  }

  assertExpectedActressVersion(draft.target.id, input.expected, input.operationId, database)
  const actress = getActressDetail(draft.target.id)
  if (!actress) {
    throw structuredError('INVALID_INPUT', '演员不存在', { entityKind: 'actress', entityId: draft.target.id }, input.operationId)
  }
  if (stored.kind !== 'actress' || draft.payload.kind !== 'actress') {
    throw structuredError('INVALID_INPUT', '演员草稿类型无效', { field: 'draftId' }, input.operationId)
  }
  if (input.uploads?.length) {
    const [avatar, ...gallery] = input.uploads
    const applied = applyActressScrapeCandidate({
      actressId: draft.target.id,
      candidate: draft.payload.result,
      avatar,
      gallery,
      expected: input.expected,
      operationId: input.operationId,
      database
    })
    const outcome: AgentMetadataApplyOutcome = {
      status: applied.applied ? 'applied' : 'no_op',
      target: draft.target,
      warnings: [...draft.warnings, ...applied.warnings]
    }
    return { ...outcome, versions: applied.versions }
  }
  const fields = new Set(stored.selection.fields)
  const avatarResource = fields.has('avatar')
    ? draft.resources.find((item) => item.field === 'avatar')
    : undefined
  const avatarPath = avatarResource
    ? mediaAssetStore.storeScrapedActressAvatar(
        actress.main_name,
        avatarResource.remoteUrl ?? draft.payload.result.avatarUrl ?? '',
        mediaAssetStore.readActressScrapeStagedImage(avatarResource.stagedPath)
      )
    : null
  const galleryAssets = fields.has('gallery')
    ? draft.resources
        .filter((item) => item.field === 'gallery')
        .sort((left, right) => left.position - right.position)
        .map((resource) => {
          const storedImage = mediaAssetStore.storeScrapedActressGalleryImage(
            actress.main_name,
            actress.id,
            resource.remoteUrl ?? '',
            mediaAssetStore.readActressScrapeStagedImage(resource.stagedPath)
          )
          return {
            remoteUrl: resource.remoteUrl,
            localPath: storedImage.localPath,
            width: storedImage.width,
            height: storedImage.height
          }
        })
    : []
  const applied = applyActressScrapeResult(
    draft.target.id,
    draft.payload.result,
    avatarPath,
    galleryAssets,
    stored.selection.fields,
    stored.selection.mode
  )
  const outcome: AgentMetadataApplyOutcome = {
    status: applied.applied ? 'applied' : 'no_op',
    target: draft.target,
    warnings: [...draft.warnings, ...applied.warnings]
  }
  return { ...outcome, versions: { A: readActressAggregateVersion(draft.target.id, database)! } }
}
