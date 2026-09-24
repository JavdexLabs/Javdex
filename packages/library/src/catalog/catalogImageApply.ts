import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { CatalogImageRef, UploadPurpose } from '@shared/protocol/uploads'
import type { ExpectedVersions } from '@shared/protocol/versions'
import { structuredError } from '@shared/protocol/errors'
import { createAvatarCropV1 } from '@shared/avatarCrop'
import { getDb } from '@library/db/database'
import { mediaAssetStore } from '@library/mediaAssetStore'
import { addVideoSampleAsset } from '@library/db/videoRepo'
import { addActressGalleryAsset, getActressAvatarRecord, updateActressAvatarRecord, type ActressAvatarBundleRecord } from '@library/db/actressRepo'
import { createPlaylistRecord, getPlaylistById, updatePlaylistRecord } from '@library/db/playlistRepo'
import {
  consumeReadyUpload,
  ensureUploadDirs,
  extensionFromUpload,
  insertImageFileJob,
  pendingScrapeRel,
  readCatalogUpload,
  readReadyUploadBytes,
  updateImageFileJob,
  writePromoteJournal
} from './catalogUploads'
import { maybeCrashImageFlow } from './catalogImageCrash'
import { commitCatalogMutation, type CatalogMutationRequest } from './catalogOperations'
import { recoverCatalogImages, recoverPromoteJournals, runCatalogImageFileJobs } from './catalogImageRecovery'
import {
  assertExpectedActressVersion,
  assertExpectedClassificationVersion,
  assertExpectedPlaylistVersion,
  assertExpectedVideoVersion,
  bumpRowRevision,
  readActressAggregateVersion,
  readClassificationAggregateVersion,
  readPlaylistAggregateVersion,
  readVideoAggregateVersion
} from './catalogAggregateVersion'
import fs from 'node:fs'
import path from 'node:path'

export interface PreparedUploadApply {
  uploadId: string
  purpose: UploadPurpose
  formalRel: string
  stagingRel: string
  jobId: string
  keepStaging: boolean
}

function nowIso(): string {
  return new Date().toISOString()
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

const pendingSourceByUpload = new Map<
  string,
  { displayPath: string; sourcePath: string; fingerprint: string }
>()

function requireUploadRef(image: CatalogImageRef, operationId?: string): string {
  if (image.kind !== 'upload') {
    throw structuredError('INVALID_INPUT', '该图片用途需要上传引用', { field: 'image' }, operationId)
  }
  return image.uploadId
}

export function prepareUploadApply(
  uploadId: string,
  expectedPurpose: UploadPurpose,
  writeFormal: (bytes: Buffer, upload: NonNullable<ReturnType<typeof readCatalogUpload>>) => string,
  operationId: string,
  options: { keepStaging?: boolean } = {},
  database: Database.Database = getDb()
): PreparedUploadApply {
  const upload = readCatalogUpload(uploadId, database)
  if (!upload) throw structuredError('INVALID_INPUT', '上传不存在', { field: 'uploadId' }, operationId)
  if (upload.purpose !== expectedPurpose) {
    throw structuredError('INVALID_INPUT', '上传用途与业务不一致', { field: 'purpose' }, operationId)
  }
  if (upload.expiresAt <= nowIso() && upload.status !== 'consumed') {
    throw structuredError('UPLOAD_EXPIRED', '上传已过期，请重新上传', undefined, operationId)
  }
  if (upload.status === 'consumed' && upload.consumedByOperationId === operationId && upload.relPath) {
    return {
      uploadId,
      purpose: upload.purpose,
      formalRel: upload.relPath,
      stagingRel: upload.relPath,
      jobId: '',
      keepStaging: Boolean(options.keepStaging)
    }
  }
  if (upload.status !== 'ready' || !upload.relPath) {
    throw structuredError('UPLOAD_NOT_READY', '上传尚未完成', undefined, operationId)
  }
  const stagingRel = upload.relPath
  const jobId = insertImageFileJob(
    { kind: 'promoteToFormal', uploadId, relPath: stagingRel, status: 'inProgress' },
    database
  )
  maybeCrashImageFlow('beforeWriteFile')
  const bytes = readReadyUploadBytes(upload)
  const formalRel = writeFormal(bytes, upload)
  writePromoteJournal(uploadId, formalRel, stagingRel)
  updateImageFileJob(jobId, { targetRelPath: formalRel }, database)
  maybeCrashImageFlow('afterWriteFile')
  return {
    uploadId,
    purpose: upload.purpose,
    formalRel,
    stagingRel,
    jobId,
    keepStaging: Boolean(options.keepStaging)
  }
}

export function commitPreparedUpload(
  prepared: PreparedUploadApply,
  operationId: string,
  oldPaths: Array<string | null | undefined>,
  database: Database.Database = getDb()
): void {
  maybeCrashImageFlow('beforeRefCommit')
  consumeReadyUpload(prepared.uploadId, operationId, prepared.purpose, database)
  if (prepared.jobId) updateImageFileJob(prepared.jobId, { status: 'done' }, database)
  if (!prepared.keepStaging && prepared.stagingRel && prepared.stagingRel !== prepared.formalRel) {
    insertImageFileJob(
      { kind: 'deleteOrphan', uploadId: prepared.uploadId, relPath: prepared.stagingRel },
      database
    )
  }
  for (const oldPath of oldPaths) {
    if (oldPath && oldPath !== prepared.formalRel) {
      insertImageFileJob(
        { kind: 'deleteReplaced', uploadId: prepared.uploadId, relPath: oldPath },
        database
      )
    }
  }
}

function videoCode(videoId: number, database: Database.Database): string {
  const row = database.prepare('SELECT code FROM videos WHERE id = ?').get(videoId) as
    | { code: string }
    | undefined
  if (!row) throw structuredError('INVALID_INPUT', '影片不存在', { entityKind: 'video', entityId: videoId })
  return row.code
}

function readVideoCover(videoId: number, database: Database.Database): string | null {
  const row = database.prepare('SELECT cover_path FROM videos WHERE id = ?').get(videoId) as
    | { cover_path: string | null }
    | undefined
  if (!row) throw structuredError('INVALID_INPUT', '影片不存在', { entityKind: 'video', entityId: videoId })
  return row.cover_path
}

export function applyVideoCoverRef(
  videoId: number,
  image: CatalogImageRef,
  expected: ExpectedVersions,
  operationId: string,
  database: Database.Database = getDb(),
  options: { bumpRevision?: boolean } = {}
): { coverPath: string | null; versions: { V: NonNullable<ReturnType<typeof readVideoAggregateVersion>> } } {
  assertExpectedVideoVersion(videoId, expected, operationId, database)
  const bump = options.bumpRevision !== false
  const revisionSql = bump ? ', revision = revision + 1' : ''
  if (image.kind === 'asset') {
    throw structuredError('INVALID_INPUT', '不能使用其它对象的资产 ID 作为封面', { field: 'image' }, operationId)
  }
  if (image.kind === 'clear') {
    const previous = readVideoCover(videoId, database)
    database
      .prepare(`UPDATE videos SET cover_path = NULL, updated_at = ?${revisionSql} WHERE id = ?`)
      .run(nowIso(), videoId)
    if (previous) insertImageFileJob({ kind: 'deleteReplaced', relPath: previous }, database)
    return { coverPath: null, versions: { V: readVideoAggregateVersion(videoId, database)! } }
  }
  const prepared = prepareUploadApply(
    image.uploadId,
    'videoCover',
    (bytes) => mediaAssetStore.importCoverFromBuffer(videoCode(videoId, database), bytes),
    operationId,
    {},
    database
  )
  const previous = readVideoCover(videoId, database)
  commitPreparedUpload(prepared, operationId, [previous], database)
  database
    .prepare(`UPDATE videos SET cover_path = ?, updated_at = ?${revisionSql} WHERE id = ?`)
    .run(prepared.formalRel, nowIso(), videoId)
  return { coverPath: prepared.formalRel, versions: { V: readVideoAggregateVersion(videoId, database)! } }
}

export function applyVideoPosterRef(
  videoId: number,
  image: CatalogImageRef,
  expected: ExpectedVersions,
  operationId: string,
  database: Database.Database = getDb()
): { posterPath: string | null; coverPath?: string | null; versions: { V: NonNullable<ReturnType<typeof readVideoAggregateVersion>> } } {
  assertExpectedVideoVersion(videoId, expected, operationId, database)
  if (image.kind === 'clear') {
    database
      .prepare('UPDATE videos SET poster_path = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?')
      .run(nowIso(), videoId)
    return { posterPath: null, versions: { V: readVideoAggregateVersion(videoId, database)! } }
  }
  if (image.kind === 'asset') {
    const sample = database
      .prepare(
        "SELECT local_path FROM video_assets WHERE id = ? AND video_id = ? AND type = 'sample'"
      )
      .get(image.assetId, videoId) as { local_path: string | null } | undefined
    if (!sample?.local_path) {
      throw structuredError('INVALID_INPUT', '海报必须来自当前影片的本地样张', { field: 'image' }, operationId)
    }
    database
      .prepare('UPDATE videos SET poster_path = ?, updated_at = ?, revision = revision + 1 WHERE id = ?')
      .run(sample.local_path, nowIso(), videoId)
    return { posterPath: sample.local_path, versions: { V: readVideoAggregateVersion(videoId, database)! } }
  }
  const cover = applyVideoCoverRef(videoId, image, expected, operationId, database)
  return { posterPath: cover.coverPath, coverPath: cover.coverPath, versions: cover.versions }
}

export function applyVideoSampleRefs(
  videoId: number,
  images: CatalogImageRef[],
  expected: ExpectedVersions,
  operationId: string,
  database: Database.Database = getDb()
): { assetIds: number[]; versions: { V: NonNullable<ReturnType<typeof readVideoAggregateVersion>> } } {
  assertExpectedVideoVersion(videoId, expected, operationId, database)
  const code = videoCode(videoId, database)
  const assetIds: number[] = []
  for (const image of images) {
    const uploadId = requireUploadRef(image, operationId)
    const prepared = prepareUploadApply(
      uploadId,
      'videoSample',
      (bytes) => mediaAssetStore.importSampleFromBuffer(code, bytes),
      operationId,
      {},
      database
    )
    commitPreparedUpload(prepared, operationId, [], database)
    const asset = addVideoSampleAsset(videoId, { localPath: prepared.formalRel })
    assetIds.push(asset.id)
  }
  database
    .prepare('UPDATE videos SET updated_at = ?, revision = revision + 1 WHERE id = ?')
    .run(nowIso(), videoId)
  return { assetIds, versions: { V: readVideoAggregateVersion(videoId, database)! } }
}

/** Prepare upload resources inside the caller's catalog transaction; no actress row write. */
export function prepareActressAvatarRef(
  actressId: number,
  image: CatalogImageRef,
  operationId: string,
  database: Database.Database = getDb()
): ActressAvatarBundleRecord | undefined {
  if (!database.inTransaction) throw new Error('Avatar preparation requires an active transaction')
  const current = getActressAvatarRecord(actressId)
  if (!current) throw structuredError('INVALID_INPUT', '演员不存在', { entityKind: 'actress', entityId: actressId })
  if (image.kind === 'asset') {
    throw structuredError('INVALID_INPUT', '不能使用其它对象的资产 ID 作为头像', { field: 'image' }, operationId)
  }
  if (image.kind === 'clear') {
    for (const oldPath of [current.avatar_path, current.avatar_source_path]) {
      if (oldPath) insertImageFileJob({ kind: 'deleteReplaced', relPath: oldPath }, database)
    }
    return { displayPath: null, sourcePath: null, cropJson: null }
  }
  const prepared = prepareUploadApply(
    image.uploadId,
    'actressAvatar',
    (bytes, upload) => {
      const source = mediaAssetStore.importAvatarSource(
        current.main_name, actressId, bytes, extensionFromUpload(upload)
      )
      const displayPath = mediaAssetStore.importAvatarDisplay(current.main_name, actressId, bytes)
      pendingSourceByUpload.set(image.uploadId, {
        displayPath, sourcePath: source.relPath, fingerprint: source.fingerprint
      })
      return displayPath
    },
    operationId,
    {},
    database
  )
  const pending = pendingSourceByUpload.get(image.uploadId)
  pendingSourceByUpload.delete(image.uploadId)
  const retained = new Set([pending?.displayPath, pending?.sourcePath])
  const obsolete = [current.avatar_path, current.avatar_source_path].filter(
    oldPath => oldPath && !retained.has(oldPath)
  )
  commitPreparedUpload(prepared, operationId, obsolete, database)
  return pending ? {
    displayPath: pending.displayPath,
    sourcePath: pending.sourcePath,
    cropJson: JSON.stringify(createAvatarCropV1({
      sourceFingerprint: pending.fingerprint, zoom: 1, offsetX: 0, offsetY: 0
    }))
  } : undefined
}

export function applyActressAvatarRef(
  actressId: number,
  image: CatalogImageRef,
  expected: ExpectedVersions,
  operationId: string,
  database: Database.Database = getDb()
): { versions: { A: NonNullable<ReturnType<typeof readActressAggregateVersion>> } } {
  assertExpectedActressVersion(actressId, expected, operationId, database)
  const bundle = prepareActressAvatarRef(actressId, image, operationId, database)
  if (bundle) updateActressAvatarRecord(actressId, bundle)
  return { versions: { A: readActressAggregateVersion(actressId, database)! } }
}

export function applyActressGalleryRefs(
  actressId: number,
  images: CatalogImageRef[],
  expected: ExpectedVersions,
  operationId: string,
  database: Database.Database = getDb()
): { assetIds: number[]; versions: { A: NonNullable<ReturnType<typeof readActressAggregateVersion>> } } {
  assertExpectedActressVersion(actressId, expected, operationId, database)
  const current = getActressAvatarRecord(actressId)
  if (!current) throw structuredError('INVALID_INPUT', '演员不存在', { entityKind: 'actress', entityId: actressId })
  const assetIds: number[] = []
  for (const image of images) {
    const uploadId = requireUploadRef(image, operationId)
    const prepared = prepareUploadApply(
      uploadId,
      'actressGallery',
      (bytes) => mediaAssetStore.importActressGalleryFromBuffer(current.main_name, bytes, actressId),
      operationId,
      {},
      database
    )
    commitPreparedUpload(prepared, operationId, [], database)
    const dims = mediaAssetStore.readStoredImageDimensions(prepared.formalRel)
    const asset = addActressGalleryAsset(actressId, {
      localPath: prepared.formalRel,
      width: dims?.width ?? null,
      height: dims?.height ?? null
    })
    assetIds.push(asset.id)
  }
  database.prepare('UPDATE actresses SET updated_at = ? WHERE id = ?').run(nowIso(), actressId)
  return { assetIds, versions: { A: readActressAggregateVersion(actressId, database)! } }
}

export function applyActressCropRef(
  input: {
    actressId: number
    sourceAssetId: number
    sourceDigest: string
    sourceVersion: string
    image: CatalogImageRef
  },
  expected: ExpectedVersions,
  operationId: string,
  database: Database.Database = getDb()
): { versions: { A: NonNullable<ReturnType<typeof readActressAggregateVersion>> } } {
  assertExpectedActressVersion(input.actressId, expected, operationId, database)
  const current = getActressAvatarRecord(input.actressId)
  if (!current) {
    throw structuredError('INVALID_INPUT', '演员不存在', { entityKind: 'actress', entityId: input.actressId })
  }
  if (input.sourceAssetId !== input.actressId) {
    throw structuredError('INVALID_INPUT', '裁切原图必须属于当前演员', { field: 'sourceAssetId' }, operationId)
  }
  if (!current.avatar_source_path) {
    throw structuredError('INVALID_INPUT', '缺少头像原图，请重新选择图片后再裁剪保存')
  }
  const sourceBytes = mediaAssetStore.readBytes(current.avatar_source_path)
  if (sha256(sourceBytes) !== input.sourceDigest) {
    throw structuredError('VERSION_CONFLICT', '头像原图已变化，请刷新后重新裁切', {
      entityKind: 'actress',
      entityId: input.actressId
    }, operationId)
  }
  const actressVersion = readActressAggregateVersion(input.actressId, database)
  if (
    input.sourceVersion !== String(actressVersion?.revision ?? '') &&
    input.sourceVersion !== sha256(sourceBytes).slice(0, 16)
  ) {
    throw structuredError('VERSION_CONFLICT', '头像原图版本已变化，请刷新后重新裁切', {
      entityKind: 'actress',
      entityId: input.actressId
    }, operationId)
  }
  const uploadId = requireUploadRef(input.image, operationId)
  const prepared = prepareUploadApply(
    uploadId,
    'actressAvatar',
    (bytes) => mediaAssetStore.importAvatarDisplay(current.main_name, input.actressId, bytes),
    operationId,
    {},
    database
  )
  const result = updateActressAvatarRecord(input.actressId, {
    displayPath: prepared.formalRel,
    sourcePath: current.avatar_source_path,
    cropJson: current.avatar_crop_json
  })
  commitPreparedUpload(
    prepared,
    operationId,
    result.obsoletePaths.filter((path) => path !== current.avatar_source_path),
    database
  )
  return { versions: { A: readActressAggregateVersion(input.actressId, database)! } }
}

const CLASSIFICATION_TABLE = {
  organization: 'organizations',
  director: 'directors',
  series: 'series'
} as const

function readClassificationImage(
  kind: 'organization' | 'director' | 'series',
  id: number,
  database: Database.Database
): { main_name: string; image_path: string | null } {
  const row = database
    .prepare(`SELECT main_name, image_path FROM ${CLASSIFICATION_TABLE[kind]} WHERE id = ?`)
    .get(id) as { main_name: string; image_path: string | null } | undefined
  if (!row) throw structuredError('INVALID_INPUT', '分类实体不存在', { entityKind: kind, entityId: id })
  return row
}

export function applyClassificationImageRef(
  entity: { kind: 'organization' | 'director' | 'series'; id: number },
  image: CatalogImageRef | { kind: 'videoCover'; videoId: number },
  expected: ExpectedVersions,
  operationId: string,
  database: Database.Database = getDb()
): { imagePath: string | null; versions: { F: NonNullable<ReturnType<typeof readClassificationAggregateVersion>> } } {
  assertExpectedClassificationVersion(entity.kind, entity.id, expected, operationId, database)
  const current = readClassificationImage(entity.kind, entity.id, database)
  if (image.kind === 'clear') {
    database
      .prepare(`UPDATE ${CLASSIFICATION_TABLE[entity.kind]} SET image_path = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?`)
      .run(nowIso(), entity.id)
    if (current.image_path) insertImageFileJob({ kind: 'deleteReplaced', relPath: current.image_path }, database)
    return {
      imagePath: null,
      versions: { F: readClassificationAggregateVersion(entity.kind, entity.id, database)! }
    }
  }
  let formalRel: string
  if (image.kind === 'videoCover') {
    const cover = readVideoCover(image.videoId, database)
    if (!cover) throw structuredError('INVALID_INPUT', '关联影片封面不存在', { field: 'image' }, operationId)
    formalRel = mediaAssetStore.storeClassificationImage(
      entity.kind,
      entity.id,
      current.main_name,
      mediaAssetStore.readBytes(cover)
    )
  } else if (image.kind === 'asset') {
    throw structuredError('INVALID_INPUT', '不能使用其它对象的资产 ID 作为分类主图', { field: 'image' }, operationId)
  } else {
    const prepared = prepareUploadApply(
      image.uploadId,
      'classificationImage',
      (bytes) => mediaAssetStore.storeClassificationImage(entity.kind, entity.id, current.main_name, bytes),
      operationId,
      {},
      database
    )
    commitPreparedUpload(prepared, operationId, [current.image_path], database)
    formalRel = prepared.formalRel
  }
  database
    .prepare(
      `UPDATE ${CLASSIFICATION_TABLE[entity.kind]} SET image_path = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`
    )
    .run(formalRel, nowIso(), entity.id)
  if (image.kind === 'videoCover' && current.image_path && current.image_path !== formalRel) {
    insertImageFileJob({ kind: 'deleteReplaced', relPath: current.image_path }, database)
  }
  return {
    imagePath: formalRel,
    versions: { F: readClassificationAggregateVersion(entity.kind, entity.id, database)! }
  }
}

export function applyPlaylistCoverRef(
  playlistId: number | null,
  image: CatalogImageRef | undefined,
  fields: { name: string; description?: string | null },
  expected: ExpectedVersions,
  operationId: string,
  database: Database.Database = getDb()
): { playlistId: number; versions: { P: NonNullable<ReturnType<typeof readPlaylistAggregateVersion>> } } {
  if (playlistId != null) {
    assertExpectedPlaylistVersion(playlistId, expected, operationId, database)
  }
  let coverRel: string | null | undefined
  const current = playlistId == null ? null : getPlaylistById(playlistId)
  if (image?.kind === 'clear') coverRel = null
  else if (image?.kind === 'asset') {
    throw structuredError('INVALID_INPUT', '不能使用其它对象的资产 ID 作为清单封面', { field: 'cover' }, operationId)
  } else if (image?.kind === 'upload') {
    const prepared = prepareUploadApply(
      image.uploadId,
      'playlistCover',
      (bytes) => mediaAssetStore.importPlaylistCoverFromBuffer(fields.name, bytes),
      operationId,
      {},
      database
    )
    commitPreparedUpload(prepared, operationId, [current?.cover_path], database)
    coverRel = prepared.formalRel
  }
  if (playlistId == null) {
    const id = createPlaylistRecord(
      { name: fields.name, description: fields.description ?? null },
      coverRel ?? null
    )
    return { playlistId: id, versions: { P: readPlaylistAggregateVersion(id, database)! } }
  }
  updatePlaylistRecord(
    playlistId,
    {
      name: fields.name,
      description: fields.description ?? null,
      removeCover: image?.kind === 'clear'
    },
    coverRel
  )
  bumpRowRevision('playlists', playlistId, database)
  return { playlistId, versions: { P: readPlaylistAggregateVersion(playlistId, database)! } }
}

export function applyPendingScrapeStagingRef(
  uploadId: string,
  operationId: string,
  database: Database.Database = getDb()
): { stagedPath: string } {
  const prepared = prepareUploadApply(
    uploadId,
    'pendingScrapeStaging',
    (bytes, upload) => {
      ensureUploadDirs()
      const rel = pendingScrapeRel(upload.uploadId, extensionFromUpload(upload))
      const abs = mediaAssetStore.resolve(rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      mediaAssetStore.writeAtomic(abs, bytes)
      return rel
    },
    operationId,
    { keepStaging: false },
    database
  )
  commitPreparedUpload(prepared, operationId, [], database)
  database
    .prepare('UPDATE catalog_image_uploads SET rel_path = ?, updated_at = ? WHERE upload_id = ?')
    .run(prepared.formalRel, nowIso(), uploadId)
  return { stagedPath: prepared.formalRel }
}

export function commitManageImageMutation<T>(
  request: CatalogMutationRequest,
  mutate: () => T,
  database: Database.Database = getDb()
): { outcome: 'applied' | 'duplicate'; receipt: import('@shared/protocol/operationReceipt').OperationReceipt; data: T } {
  try {
    const result = commitCatalogMutation(request, mutate, database)
    maybeCrashImageFlow('afterRefCommit')
    recoverPromoteJournals(database)
    runCatalogImageFileJobs(database)
    return result
  } catch (error) {
    recoverCatalogImages(database)
    throw error
  }
}
