import type Database from 'better-sqlite3'
import type {
  AgentMetadataApplyTransfer,
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
import {
  replacePendingVideoScrapeFromUploads,
  submitActressScrapeConflict
} from '@library/catalog/catalogScrapeApply'
import { inspectCatalogUpload } from '@library/catalog/catalogUploads'
import { buildAgentMetadataReview } from '@library/catalog/catalogAgentMetadataReview'

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

function verifiedTransferUploads(
  transfer: AgentMetadataApplyTransfer,
  database: Database.Database,
  operationId: string
): Map<string, Extract<CatalogImageRef, { kind: 'upload' }>> {
  const resources = new Map(
    transfer.candidate.resources.map((resource) => [`${resource.field}:${resource.position}`, resource])
  )
  const uploads = new Map<string, Extract<CatalogImageRef, { kind: 'upload' }>>()
  for (const item of transfer.uploads) {
    const key = `${item.field}:${item.position}`
    const resource = resources.get(key)
    if (!resource || uploads.has(key)) {
      throw structuredError('INVALID_INPUT', '候选图片与上传清单不一致', { field: 'transfer.uploads' }, operationId)
    }
    const inspected = inspectCatalogUpload(item.image.uploadId, {}, database)
    if (
      inspected.consumed ||
      inspected.byteLength !== resource.sizeBytes ||
      inspected.sha256 !== resource.sha256 ||
      (resource.width != null && inspected.width !== resource.width) ||
      (resource.height != null && inspected.height !== resource.height)
    ) {
      throw structuredError('INVALID_INPUT', '候选图片上传内容与桌面预览不一致', { field: key }, operationId)
    }
    uploads.set(key, item.image)
  }
  return uploads
}

/** Apply a desktop-owned candidate without persisting Agent runtime state on the server. */
export function applyTransferredAgentMetadataCandidate(input: {
  transfer: AgentMetadataApplyTransfer
  reviewToken: string
  expected: ExpectedVersions
  operationId: string
  database?: Database.Database
}): CatalogDraftOutcome {
  const database = input.database ?? getDb()
  const { candidate, review } = input.transfer
  if (
    candidate.draftId !== review.draftId ||
    candidate.target.kind !== review.kind ||
    candidate.revision !== review.revision ||
    review.token !== input.reviewToken
  ) {
    throw structuredError('VERSION_CONFLICT', '预览已过期，请重新检查后再应用。', { field: 'reviewToken' }, input.operationId)
  }
  const fresh = buildAgentMetadataReview(candidate, review.selection, review.revision, { includeVersions: true })
  if (fresh.token !== review.token) {
    throw structuredError('VERSION_CONFLICT', '资料库内容已变化，请重新检查预览。', { field: 'reviewToken' }, input.operationId)
  }
  if (!fresh.canApply) {
    throw structuredError('INVALID_INPUT', '当前预览仍有必须处理的问题。', { field: 'reviewToken' }, input.operationId)
  }
  const uploads = verifiedTransferUploads(input.transfer, database, input.operationId)
  const image = (field: string, position: number) => uploads.get(`${field}:${position}`)

  if (candidate.target.kind === 'video' && candidate.payload.kind === 'video' && fresh.kind === 'video') {
    const selected = new Set(fresh.selection.fields)
    const cover = selected.has('cover') ? image('cover', 0) : undefined
    const samples = selected.has('samples')
      ? (candidate.payload.result.sampleImageUrls ?? []).map((_, position) => image('samples', position))
      : []
    if (samples.some((item) => !item)) {
      throw structuredError('INVALID_INPUT', '样例图片上传不完整', { field: 'transfer.uploads' }, input.operationId)
    }
    const actressAvatars = candidate.resources
      .filter((resource) => resource.field === 'actressAvatar')
      .flatMap((resource) => {
        const actress = candidate.payload.kind === 'video'
          ? candidate.payload.result.actresses?.[resource.position]
          : undefined
        const uploaded = image('actressAvatar', resource.position)
        const gender = actress?.gender ?? 'female'
        const selectedGender = gender === 'male'
          ? selected.has('actressesMale')
          : selected.has('actressesFemale')
        return actress?.name && uploaded && selectedGender ? [{ name: actress.name, image: uploaded }] : []
      })
    if (fresh.identityConflictVideoId) {
      const routed = replacePendingVideoScrapeFromUploads({
        videoId: candidate.target.id,
        selectedFields: fresh.selection.fields,
        applicableFields: [...new Set(fresh.impacts.filter(item => item.action !== 'preserve').map(item => item.field))],
        updateMode: fresh.selection.mode,
        request: {
          source: 'agent-metadata',
          sourceUrl: candidate.source.displayUrl,
          fields: fresh.selection.fields,
          mode: fresh.selection.mode
        },
        warnings: fresh.warnings,
        sources: [{
          pluginName: 'Agent 元数据采集',
          pluginSource: 'builtin',
          sourceName: candidate.source.sourceName ?? 'Agent',
          selectedFields: fresh.selection.fields,
          candidates: [{
            result: candidate.payload.result,
            sourceUrl: candidate.source.displayUrl,
            cover,
            samples: samples.filter((item): item is NonNullable<typeof item> => Boolean(item)),
            actressAvatars
          }]
        }],
        expected: input.expected,
        operationId: input.operationId,
        database
      })
      return {
        status: 'routed_to_pending',
        target: candidate.target,
        pendingKind: 'video',
        pendingId: routed.pendingScrapeId,
        warnings: fresh.warnings,
        versions: routed.versions
      }
    }
    const applied = applyVideoScrapeCandidate({
      videoId: candidate.target.id,
      fields: fresh.selection.fields,
      mode: fresh.selection.mode,
      candidate: candidate.payload.result,
      sourceName: candidate.source.sourceName,
      ratingSourceName: candidate.source.sourceName,
      cover,
      samples: samples.filter((item): item is NonNullable<typeof item> => Boolean(item)),
      actressAvatars,
      directorSelectionId: fresh.selection.directorSelectionId,
      directorAmbiguity: 'choice',
      expected: input.expected,
      operationId: input.operationId,
      database
    })
    return {
      status: applied.applied ? 'applied' : 'no_op',
      target: candidate.target,
      warnings: [...candidate.warnings, ...applied.warnings],
      versions: applied.versions
    }
  }

  if (candidate.target.kind !== 'actress' || candidate.payload.kind !== 'actress' || fresh.kind !== 'actress') {
    throw structuredError('INVALID_INPUT', '候选与预览类型不一致', { field: 'transfer' }, input.operationId)
  }
  const selected = new Set(fresh.selection.fields)
  const avatar = selected.has('avatar') ? image('avatar', 0) : undefined
  const gallery = selected.has('gallery')
    ? (candidate.payload.result.galleryImageUrls ?? []).map((_, position) => image('gallery', position))
    : []
  if (gallery.some((item) => !item)) {
    throw structuredError('INVALID_INPUT', '写真上传不完整', { field: 'transfer.uploads' }, input.operationId)
  }
  if (fresh.nameConflicts?.length) {
    const actress = getActressDetail(candidate.target.id)
    if (!actress) throw structuredError('INVALID_INPUT', '演员不存在', { entityKind: 'actress', entityId: candidate.target.id }, input.operationId)
    const routed = submitActressScrapeConflict({
      actressId: candidate.target.id,
      pluginName: 'Agent 元数据采集',
      pluginSource: 'builtin',
      queryName: candidate.payload.result.mainName ?? actress.main_name,
      selectedFields: fresh.selection.fields,
      applicableFields: [...new Set(fresh.impacts.filter(item => item.action !== 'preserve').map(item => item.field))],
      mode: fresh.selection.mode,
      candidate: candidate.payload.result,
      warnings: fresh.warnings,
      avatar,
      gallery: gallery.filter((item): item is NonNullable<typeof item> => Boolean(item)),
      expected: input.expected,
      operationId: input.operationId,
      database
    })
    return {
      status: 'routed_to_pending',
      target: candidate.target,
      pendingKind: 'actress',
      pendingId: routed.pendingId,
      warnings: fresh.warnings,
      versions: routed.versions
    }
  }
  const applied = applyActressScrapeCandidate({
    actressId: candidate.target.id,
    candidate: candidate.payload.result,
    avatar,
    gallery: gallery.filter((item): item is NonNullable<typeof item> => Boolean(item)),
    fields: fresh.selection.fields,
    mode: fresh.selection.mode,
    expected: input.expected,
    operationId: input.operationId,
    database
  })
  return {
    status: applied.applied ? 'applied' : 'no_op',
    target: candidate.target,
    warnings: [...candidate.warnings, ...applied.warnings],
    versions: applied.versions
  }
}

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
