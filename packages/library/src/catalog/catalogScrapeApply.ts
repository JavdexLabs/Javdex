import type Database from 'better-sqlite3'
import type { ActressScrapeResult } from '@shared/actressScrapeTypes'
import { ALL_ACTRESS_SCRAPE_FIELDS } from '@shared/actressScrapeTypes'
import type { ScrapeResult, VideoScrapeField, VideoScrapeUpdateMode } from '@shared/videoScrapeTypes'
import type { CatalogImageRef } from '@shared/protocol/uploads'
import type { ExpectedVersions } from '@shared/protocol/versions'
import { structuredError } from '@shared/protocol/errors'
import { getDb } from '@library/db/database'
import { getVideoById, hasPendingVideoScrape } from '@library/db/videoRepo'
import { getActressAvatarRecord } from '@library/db/actressRepo'
import { mediaAssetStore } from '@library/mediaAssetStore'
import { applyActressScrapeResult } from '@library/catalog/actressAssetService'
import { applyScrapeResult } from '@library/catalog/videoScrapeApplyService'
import {
  assertExpectedActressVersion,
  assertExpectedVideoVersion,
  bumpRowRevision,
  readActressAggregateVersion,
  readVideoAggregateVersion
} from '@library/catalog/catalogAggregateVersion'
import {
  commitPreparedUpload,
  prepareUploadApply
} from '@library/catalog/catalogImageApply'

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

function resolveUploadPath(
  image: CatalogImageRef | undefined,
  purpose: 'videoCover' | 'videoSample' | 'actressAvatar' | 'actressGallery',
  writeFormal: (bytes: Buffer) => string,
  operationId: string,
  database: Database.Database
): string | null {
  if (!image || image.kind === 'clear') return null
  if (image.kind !== 'upload') {
    throw structuredError('INVALID_INPUT', '刮削应用只接受上传引用', { field: 'image' }, operationId)
  }
  const prepared = prepareUploadApply(image.uploadId, purpose, (bytes) => writeFormal(bytes), operationId, {}, database)
  commitPreparedUpload(prepared, operationId, [], database)
  return prepared.formalRel
}

export function applyVideoScrapeCandidate(input: {
  videoId: number
  fields: VideoScrapeField[]
  mode: VideoScrapeUpdateMode
  candidate: unknown
  cover?: CatalogImageRef
  samples?: CatalogImageRef[]
  expected: ExpectedVersions
  operationId: string
  database?: Database.Database
}): {
  applied: boolean
  warnings: string[]
  videoId: number
  versions: { V: NonNullable<ReturnType<typeof readVideoAggregateVersion>> }
} {
  const database = input.database ?? getDb()
  assertExpectedVideoVersion(input.videoId, input.expected, input.operationId, database)
  if (hasPendingVideoScrape(input.videoId)) {
    throw structuredError(
      'INVALID_INPUT',
      '该影片存在待确认刮削结果，请先确认或丢弃后再应用候选',
      { entityKind: 'video', entityId: input.videoId },
      input.operationId
    )
  }
  const video = getVideoById(input.videoId, database)
  if (!video) {
    throw structuredError('INVALID_INPUT', '影片不存在', { entityKind: 'video', entityId: input.videoId }, input.operationId)
  }
  const result = asScrapeResult(input.candidate, input.operationId)
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
  const applied = applyScrapeResult(
    input.videoId,
    result,
    coverPath,
    new Map(),
    samplePaths,
    input.fields,
    undefined,
    input.mode
  )
  if (applied.applied) bumpRowRevision('videos', input.videoId, database)
  return {
    applied: applied.applied,
    warnings: applied.warnings,
    videoId: input.videoId,
    versions: { V: readVideoAggregateVersion(input.videoId, database)! }
  }
}

export function applyActressScrapeCandidate(input: {
  actressId: number
  candidate: unknown
  avatar?: CatalogImageRef
  gallery?: CatalogImageRef[]
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
    ALL_ACTRESS_SCRAPE_FIELDS,
    'replace'
  )
  return {
    applied: applied.applied,
    warnings: applied.warnings,
    actressId: input.actressId,
    versions: { A: readActressAggregateVersion(input.actressId, database)! }
  }
}
