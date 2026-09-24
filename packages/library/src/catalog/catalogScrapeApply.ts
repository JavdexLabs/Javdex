import type Database from 'better-sqlite3'
import type { ActressScrapeField, ActressScrapeResult, ActressScrapeUpdateMode } from '@shared/actressScrapeTypes'
import { ALL_ACTRESS_SCRAPE_FIELDS } from '@shared/actressScrapeTypes'
import type {
  ScrapeResult,
  VideoDirectorChoiceRequired,
  VideoScrapeField,
  VideoScrapeUpdateMode
} from '@shared/videoScrapeTypes'
import type { CatalogImageRef } from '@shared/protocol/uploads'
import type { ExpectedVersions } from '@shared/protocol/versions'
import { structuredError } from '@shared/protocol/errors'
import { getDb } from '@library/db/database'
import { getVideoById } from '@library/db/videoRepo'
import { getActressAvatarRecord } from '@library/db/actressRepo'
import { mediaAssetStore } from '@library/mediaAssetStore'
import { applyActressScrapeResult } from '@library/catalog/actressAssetService'
import {
  findVideoBusinessIdentityConflictForScrape,
  videoScrapeApplyService,
  applyScrapeResult
} from '@library/catalog/videoScrapeApplyService'
import {
  findActressScrapeNameConflicts,
  actressIdentityConflictWorkflow
} from '@library/catalog/actressIdentityConflictWorkflow'
import {
  assertExpectedActressVersion,
  assertExpectedVideoVersion,
  bumpRowRevision,
  readActressAggregateVersion,
  readVideoAggregateVersion
} from '@library/catalog/catalogAggregateVersion'
import {
  applyPendingScrapeStagingRef,
  commitPreparedUpload,
  prepareUploadApply
} from '@library/catalog/catalogImageApply'
import {
  deletePendingVideoScrape,
  getPendingVideoScrapeForVideo,
  replacePendingVideoScrape,
  type PendingVideoScrapeCandidateInput,
  type PendingVideoScrapeSourceInput
} from '@library/db/pendingVideoScrapeRepo'
import type { PendingActressScrapeResource } from '@shared/actressConflictTypes'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asScrapeResult(candidate: unknown, operationId: string): ScrapeResult {
  if (!isRecord(candidate) || typeof candidate.code !== 'string' || !candidate.code.trim()) {
    throw structuredError('INVALID_INPUT', '刮削候选缺少番号', { field: 'candidate' }, operationId)
  }
  return candidate as unknown as ScrapeResult
}

function asActressScrapeResult(candidate: unknown, operationId: string): ActressScrapeResult {
  if (!isRecord(candidate)) {
    throw structuredError('INVALID_INPUT', '演员刮削候选无效', { field: 'candidate' }, operationId)
  }
  return candidate as unknown as ActressScrapeResult
}

function requireUpload(
  image: CatalogImageRef | undefined,
  operationId: string
): string | null {
  if (!image || image.kind === 'clear') return null
  if (image.kind !== 'upload') {
    throw structuredError('INVALID_INPUT', '刮削应用只接受上传引用', { field: 'image' }, operationId)
  }
  return image.uploadId
}

function resolveUploadPath(
  image: CatalogImageRef | undefined,
  purpose: 'videoCover' | 'videoSample' | 'actressAvatar' | 'actressGallery',
  writeFormal: (bytes: Buffer) => string,
  operationId: string,
  database: Database.Database
): string | null {
  const uploadId = requireUpload(image, operationId)
  if (!uploadId) return null
  const prepared = prepareUploadApply(uploadId, purpose, (bytes) => writeFormal(bytes), operationId, {}, database)
  commitPreparedUpload(prepared, operationId, [], database)
  return prepared.formalRel
}

function requireVideoQIfPending(
  videoId: number,
  expected: ExpectedVersions,
  operationId: string
): { id: number; revision: number } | null {
  const pending = getPendingVideoScrapeForVideo(videoId)
  if (!pending) return null
  const revision = expected.Q?.revision
  if (revision == null) {
    throw structuredError(
      'INVALID_INPUT',
      '待确认操作需要 Q 版本',
      { field: 'expectedVersions.Q' },
      operationId
    )
  }
  if (pending.revision !== revision) {
    throw structuredError('VERSION_CONFLICT', '待确认刮削结果已变化，请刷新后重新确认', undefined, operationId)
  }
  return { id: pending.id, revision: pending.revision }
}

function pendingActressRow(actressId: number, database: Database.Database): { id: number; revision: number } | null {
  const row = database
    .prepare('SELECT id, revision FROM pending_actress_scrapes WHERE actress_id = ?')
    .get(actressId) as { id: number; revision: number } | undefined
  return row ?? null
}

function requireActressQIfPending(
  actressId: number,
  expected: ExpectedVersions,
  operationId: string,
  database: Database.Database
): { id: number; revision: number } | null {
  const pending = pendingActressRow(actressId, database)
  if (!pending) return null
  if (expected.Q && pending.revision !== expected.Q.revision) {
    throw structuredError('VERSION_CONFLICT', '待确认刮削结果已变化，请刷新后重新确认', undefined, operationId)
  }
  return pending
}

function stagePendingImage(
  image: CatalogImageRef | undefined,
  operationId: string,
  database: Database.Database
): string | null {
  const uploadId = requireUpload(image, operationId)
  if (!uploadId) return null
  return applyPendingScrapeStagingRef(uploadId, operationId, database).stagedPath
}

export function applyVideoScrapeCandidate(input: {
  videoId: number
  fields: VideoScrapeField[]
  mode: VideoScrapeUpdateMode
  candidate: unknown
  sourceName?: string
  ratingSourceName?: string
  cover?: CatalogImageRef
  samples?: CatalogImageRef[]
  actressAvatars?: Array<{ name: string; image: CatalogImageRef }>
  directorSelectionId?: number
  directorAmbiguity?: 'choice' | 'preserve'
  expected: ExpectedVersions
  operationId: string
  database?: Database.Database
}): {
  applied: boolean
  warnings: string[]
  videoId: number
  directorChoice?: VideoDirectorChoiceRequired
  versions: { V: NonNullable<ReturnType<typeof readVideoAggregateVersion>> }
} {
  const database = input.database ?? getDb()
  assertExpectedVideoVersion(input.videoId, input.expected, input.operationId, database)
  const pending = requireVideoQIfPending(input.videoId, input.expected, input.operationId)
  const video = getVideoById(input.videoId, database)
  if (!video) {
    throw structuredError('INVALID_INPUT', '影片不存在', { entityKind: 'video', entityId: input.videoId }, input.operationId)
  }
  const result = asScrapeResult(input.candidate, input.operationId)
  const conflictVideoId = findVideoBusinessIdentityConflictForScrape(
    input.videoId,
    result,
    input.fields,
    input.mode
  )
  if (conflictVideoId != null) {
    throw structuredError(
      'IDENTITY_CONFLICT',
      `候选会与影片 ID ${conflictVideoId} 的业务身份冲突，请改为待确认提交`,
      { entityKind: 'video', entityId: conflictVideoId, field: 'candidate' },
      input.operationId
    )
  }
  const classificationOptions = {
    directorSelectionId: input.directorSelectionId,
    directorAmbiguity: input.directorAmbiguity ?? 'preserve'
  }
  const preflight = videoScrapeApplyService.preflightClassifications(
    input.videoId,
    result,
    input.fields,
    input.mode,
    classificationOptions
  )
  if (preflight.directorChoice) {
    return {
      applied: false,
      warnings: preflight.warnings,
      videoId: input.videoId,
      directorChoice: preflight.directorChoice,
      versions: { V: readVideoAggregateVersion(input.videoId, database)! }
    }
  }
  const coverPath = resolveUploadPath(
    input.cover,
    'videoCover',
    (bytes) => mediaAssetStore.importCoverFromBuffer(video.code, bytes),
    input.operationId,
    database
  )
  const samplePaths = (input.samples ?? []).map((image) =>
    resolveUploadPath(
      image,
      'videoSample',
      (bytes) => mediaAssetStore.importSampleFromBuffer(video.code, bytes),
      input.operationId,
      database
    )
  )
  const actressAvatars = new Map<string, string | null>()
  for (const avatar of input.actressAvatars ?? []) {
    const path = resolveUploadPath(
      avatar.image,
      'actressAvatar',
      (bytes) => mediaAssetStore.storeScrapedActressAvatar(avatar.name, '', bytes),
      input.operationId,
      database
    )
    actressAvatars.set(avatar.name, path)
  }
  const applied = applyScrapeResult(
    input.videoId,
    result,
    coverPath,
    actressAvatars,
    samplePaths,
    input.fields,
    input.sourceName,
    input.mode,
    input.ratingSourceName,
    classificationOptions
  )
  if (applied.applied) {
    if (pending) {
      const deleted = deletePendingVideoScrape(pending.id)
      if (deleted?.stagedPaths.length) {
        mediaAssetStore.cleanupVideoScrapeStagingPaths(deleted.stagedPaths)
      }
    }
    bumpRowRevision('videos', input.videoId, database)
  }
  return {
    applied: applied.applied,
    warnings: applied.warnings,
    videoId: input.videoId,
    directorChoice: applied.directorChoice,
    versions: { V: readVideoAggregateVersion(input.videoId, database)! }
  }
}

export function applyActressScrapeCandidate(input: {
  actressId: number
  candidate: unknown
  avatar?: CatalogImageRef
  gallery?: CatalogImageRef[]
  fields?: ActressScrapeField[]
  mode?: ActressScrapeUpdateMode
  expected: ExpectedVersions
  operationId: string
  database?: Database.Database
}): {
  applied: boolean
  warnings: string[]
  actressId: number
  versions: { A: NonNullable<ReturnType<typeof readActressAggregateVersion>> }
} {
  const database = input.database ?? getDb()
  assertExpectedActressVersion(input.actressId, input.expected, input.operationId, database)
  requireActressQIfPending(input.actressId, input.expected, input.operationId, database)
  const current = getActressAvatarRecord(input.actressId)
  if (!current) {
    throw structuredError(
      'INVALID_INPUT',
      '演员不存在',
      { entityKind: 'actress', entityId: input.actressId },
      input.operationId
    )
  }
  const result = asActressScrapeResult(input.candidate, input.operationId)
  const fields = input.fields?.length ? input.fields : ALL_ACTRESS_SCRAPE_FIELDS
  const mode = input.mode ?? 'replace'
  const conflicts = findActressScrapeNameConflicts(input.actressId, fields, result)
  if (conflicts.length > 0) {
    throw structuredError(
      'IDENTITY_CONFLICT',
      '存在名称归属冲突，请改为冲突提交',
      { entityKind: 'actress', entityId: input.actressId, field: 'candidate' },
      input.operationId
    )
  }
  const avatarPath = resolveUploadPath(
    input.avatar,
    'actressAvatar',
    (bytes) => mediaAssetStore.importAvatarDisplay(current.main_name, input.actressId, bytes),
    input.operationId,
    database
  )
  const galleryAssets = (input.gallery ?? []).flatMap((image) => {
    const localPath = resolveUploadPath(
      image,
      'actressGallery',
      (bytes) => mediaAssetStore.importActressGalleryFromBuffer(current.main_name, bytes, input.actressId),
      input.operationId,
      database
    )
    return localPath ? [{ localPath, remoteUrl: null }] : []
  })
  const applied = applyActressScrapeResult(
    input.actressId,
    result,
    avatarPath,
    galleryAssets,
    fields,
    mode,
    () => {
      database.prepare('DELETE FROM pending_actress_scrapes WHERE actress_id = ?').run(input.actressId)
    }
  )
  return {
    applied: applied.applied,
    warnings: applied.warnings,
    actressId: input.actressId,
    versions: { A: readActressAggregateVersion(input.actressId, database)! }
  }
}

export interface PendingVideoScrapeReplaceSourceInput {
  pluginName: string
  pluginSource: 'builtin' | 'user' | 'composite'
  pluginVersion?: string | null
  pluginConfig?: unknown
  sourceName: string
  selectedFields: VideoScrapeField[]
  candidates: Array<{
    result: unknown
    sourceUrl?: string | null
    cover?: CatalogImageRef
    samples?: CatalogImageRef[]
    actressAvatars?: Array<{ name: string; image: CatalogImageRef }>
  }>
}

export function replacePendingVideoScrapeFromUploads(input: {
  videoId: number
  selectedFields: VideoScrapeField[]
  applicableFields: VideoScrapeField[]
  updateMode: VideoScrapeUpdateMode
  request?: unknown
  warnings?: string[]
  batchJobId?: string | null
  sources: PendingVideoScrapeReplaceSourceInput[]
  expected: ExpectedVersions
  operationId: string
  database?: Database.Database
}): {
  pendingScrapeId: number
  versions: {
    V: NonNullable<ReturnType<typeof readVideoAggregateVersion>>
    Q: { generation: number; revision: number }
  }
} {
  const database = input.database ?? getDb()
  assertExpectedVideoVersion(input.videoId, input.expected, input.operationId, database)
  requireVideoQIfPending(input.videoId, input.expected, input.operationId)
  const video = getVideoById(input.videoId, database)
  if (!video) {
    throw structuredError('INVALID_INPUT', '影片不存在', { entityKind: 'video', entityId: input.videoId }, input.operationId)
  }
  const sources: PendingVideoScrapeSourceInput[] = input.sources.map((source) => ({
    pluginName: source.pluginName,
    pluginSource: source.pluginSource,
    pluginVersion: source.pluginVersion ?? null,
    pluginConfig: source.pluginConfig ?? {},
    sourceName: source.sourceName,
    selectedFields: source.selectedFields,
    candidates: source.candidates.map((candidate): PendingVideoScrapeCandidateInput => {
      const result = asScrapeResult(candidate.result, input.operationId)
      const resources: PendingVideoScrapeCandidateInput['resources'] = []
      const coverPath = stagePendingImage(candidate.cover, input.operationId, database)
      if (coverPath) {
        resources.push({
          field: 'cover',
          position: 0,
          remoteUrl: result.sourceUrl ?? null,
          stagedPath: coverPath
        })
      }
      ;(candidate.samples ?? []).forEach((image, position) => {
        const stagedPath = stagePendingImage(image, input.operationId, database)
        if (!stagedPath) return
        resources.push({
          field: 'samples',
          position,
          remoteUrl: result.sampleImageUrls?.[position] ?? null,
          stagedPath
        })
      })
      for (const avatar of candidate.actressAvatars ?? []) {
        const stagedPath = stagePendingImage(avatar.image, input.operationId, database)
        if (!stagedPath) continue
        const position = Math.max(
          0,
          (result.actresses ?? []).findIndex((actress) => actress.name === avatar.name)
        )
        resources.push({
          field: 'actressAvatar',
          position,
          remoteUrl: result.actresses?.[position]?.avatarUrl ?? null,
          stagedPath
        })
      }
      return {
        result,
        sourceUrl: candidate.sourceUrl ?? result.sourceUrl ?? null,
        normalizedSourceUrl: candidate.sourceUrl ?? result.sourceUrl ?? null,
        resources
      }
    })
  }))
  const persisted = replacePendingVideoScrape({
    videoId: input.videoId,
    selectedFields: input.selectedFields,
    applicableFields: input.applicableFields,
    updateMode: input.updateMode,
    request: input.request ?? null,
    warnings: input.warnings ?? [],
    batchJobId: input.batchJobId,
    sources
  })
  if (persisted.obsoletePaths.length) {
    mediaAssetStore.cleanupVideoScrapeStagingPaths(persisted.obsoletePaths)
  }
  const pending = getPendingVideoScrapeForVideo(input.videoId)
  if (!pending) throw structuredError('INVALID_INPUT', '待确认刮削结果写入失败', undefined, input.operationId)
  return {
    pendingScrapeId: persisted.pendingScrapeId,
    versions: {
      V: readVideoAggregateVersion(input.videoId, database)!,
      Q: { generation: 1, revision: pending.revision }
    }
  }
}

export function submitActressScrapeConflict(input: {
  actressId: number
  pluginName: string
  pluginSource: 'builtin' | 'user' | 'composite'
  pluginVersion?: string | null
  queryName: string
  selectedFields: ActressScrapeField[]
  applicableFields: ActressScrapeField[]
  mode: ActressScrapeUpdateMode
  candidate: unknown
  warnings?: string[]
  batchJobId?: string | null
  avatar?: CatalogImageRef
  gallery?: CatalogImageRef[]
  expected: ExpectedVersions
  operationId: string
  database?: Database.Database
}): {
  pendingId: number
  versions: {
    A: NonNullable<ReturnType<typeof readActressAggregateVersion>>
    Q: { generation: number; revision: number }
  }
} {
  const database = input.database ?? getDb()
  assertExpectedActressVersion(input.actressId, input.expected, input.operationId, database)
  requireActressQIfPending(input.actressId, input.expected, input.operationId, database)
  const current = getActressAvatarRecord(input.actressId)
  if (!current) {
    throw structuredError(
      'INVALID_INPUT',
      '演员不存在',
      { entityKind: 'actress', entityId: input.actressId },
      input.operationId
    )
  }
  const result = asActressScrapeResult(input.candidate, input.operationId)
  const resources: PendingActressScrapeResource[] = []
  const avatarPath = stagePendingImage(input.avatar, input.operationId, database)
  if (avatarPath) {
    resources.push({
      field: 'avatar',
      position: 0,
      remoteUrl: result.avatarUrl,
      stagedPath: avatarPath,
      width: null,
      height: null
    })
  }
  ;(input.gallery ?? []).forEach((image, position) => {
    const stagedPath = stagePendingImage(image, input.operationId, database)
    if (!stagedPath) return
    resources.push({
      field: 'gallery',
      position,
      remoteUrl: result.galleryImageUrls?.[position],
      stagedPath,
      width: null,
      height: null
    })
  })
  let routed: { pendingId: number; obsoleteStagedPaths: string[] }
  try {
    routed = actressIdentityConflictWorkflow.routeStagedScrape({
      actressId: input.actressId,
      plugin: {
        name: input.pluginName,
        source: input.pluginSource,
        ...(input.pluginVersion ? { version: input.pluginVersion } : {})
      },
      queryName: input.queryName,
      selectedFields: input.selectedFields,
      applicableFields: input.applicableFields,
      mode: input.mode,
      result,
      warnings: input.warnings ?? [],
      resources,
      batchJobId: input.batchJobId
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw structuredError('INVALID_INPUT', message, { entityKind: 'actress', entityId: input.actressId }, input.operationId)
  }
  if (routed.obsoleteStagedPaths.length) {
    mediaAssetStore.cleanupVideoScrapeStagingPaths(routed.obsoleteStagedPaths)
  }
  const pending = pendingActressRow(input.actressId, database)
  if (!pending) {
    throw structuredError('INVALID_INPUT', '演员冲突待确认写入失败', undefined, input.operationId)
  }
  return {
    pendingId: routed.pendingId,
    versions: {
      A: readActressAggregateVersion(input.actressId, database)!,
      Q: { generation: 1, revision: pending.revision }
    }
  }
}
