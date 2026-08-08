import type {
  ActressAvatarSourceInfo,
  ActressEditInput,
  ActressMergeMainNameFrom
} from '@shared/actressTypes'
import type {
  ActressScrapeField,
  ActressScrapeResult,
  ActressScrapeUpdateMode
} from '@shared/scrapeTypes'
import { createAvatarCropV1, parseAvatarCrop, type ActressAvatarCommit } from '@shared/avatarCrop'
import {
  applyActressScrapeResult as applyActressScrapeResultRecord,
  clearActressAvatarRecord,
  editActress as editActressRecord,
  getActressAvatarRecord,
  mergeActresses as mergeActressRecords,
  planActressScrapeResult as planActressScrapeResultRecord,
  resolveEffectiveActressScrapeFields as resolveEffectiveActressScrapeFieldsRecord,
  updateActressAvatarRecord,
  upsertActressFromScrape as upsertActressRecord,
  type ActressScrapeAssetFacts
} from '../db/actressRepo'
import { getDb } from '../db/database'
import { mediaAssetStore } from './mediaAssetStore'

interface GalleryAssetWriteInput {
  remoteUrl?: string | null
  localPath?: string | null
  width?: number | null
  height?: number | null
}

function sourceFingerprint(storedPath: string): string | null {
  if (!mediaAssetStore.isUsableImage(storedPath)) return null
  try {
    return mediaAssetStore.fingerprint(mediaAssetStore.readBytes(storedPath))
  } catch {
    return null
  }
}

export function getActressAvatarSourceInfo(id: number): ActressAvatarSourceInfo | null {
  const actress = getActressAvatarRecord(id)
  if (!actress) return null
  const sourceFingerprintValue = actress.avatar_source_path
    ? sourceFingerprint(actress.avatar_source_path)
    : null
  const assetPath = sourceFingerprintValue
    ? actress.avatar_source_path
    : actress.avatar_path
  if (!assetPath) return null
  const fingerprint = sourceFingerprintValue ?? sourceFingerprint(assetPath)
  if (!fingerprint) return null
  return {
    assetPath,
    sourceFingerprint: fingerprint,
    requiresSourceAdoption: !sourceFingerprintValue
  }
}

export function clearBrokenActressAvatarIfNeeded(id: number): boolean {
  const row = getActressAvatarRecord(id)
  if (!row) return false
  const displayBroken = Boolean(row.avatar_path && !mediaAssetStore.isUsableImage(row.avatar_path))
  const sourceBroken = Boolean(
    row.avatar_source_path && !mediaAssetStore.isUsableImage(row.avatar_source_path)
  )
  const cropOrphan = Boolean(row.avatar_crop_json && !row.avatar_source_path)
  const result = clearActressAvatarRecord(id, {
    display: displayBroken,
    source: sourceBroken,
    crop: sourceBroken || cropOrphan
  })
  for (const storedPath of result.obsoletePaths) mediaAssetStore.deleteBestEffort(storedPath)
  return result.changed
}

function readCommitSource(
  commit: ActressAvatarCommit,
  currentSourcePath: string | null
): { bytes: Buffer; extension: string; fingerprint: string } | null {
  let bytes: Buffer
  let extension = '.jpg'
  if (commit.sourceImageBase64) {
    bytes = Buffer.from(commit.sourceImageBase64, 'base64')
  } else if (commit.sourceLocalPath) {
    bytes = mediaAssetStore.readExternalFile(commit.sourceLocalPath)
    extension = mediaAssetStore.extensionOf(commit.sourceLocalPath)
  } else if (commit.sourceAssetPath) {
    bytes = mediaAssetStore.readBytes(commit.sourceAssetPath)
    extension = mediaAssetStore.extensionOf(commit.sourceAssetPath)
  } else if (currentSourcePath && mediaAssetStore.isUsableImage(currentSourcePath)) {
    bytes = mediaAssetStore.readBytes(currentSourcePath)
    extension = mediaAssetStore.extensionOf(currentSourcePath)
  } else {
    return null
  }
  const detected = mediaAssetStore.detectImageExtension(bytes)
  if (!mediaAssetStore.readImageDimensions(bytes) && !detected) throw new Error('头像原图无效')
  return {
    bytes,
    extension: detected ?? extension,
    fingerprint: mediaAssetStore.fingerprint(bytes)
  }
}

function createDefaultAvatarBundle(id: number, mainName: string, bytes: Buffer, extension: string) {
  if (!mediaAssetStore.readImageDimensions(bytes)) throw new Error('头像图片无效')
  const source = mediaAssetStore.importAvatarSource(mainName, id, bytes, extension)
  const displayPath = mediaAssetStore.importAvatarDisplay(mainName, id, bytes)
  return {
    displayPath,
    sourcePath: source.relPath,
    cropJson: JSON.stringify(createAvatarCropV1({
      sourceFingerprint: source.fingerprint,
      zoom: 1,
      offsetX: 0,
      offsetY: 0
    }))
  }
}

export function setActressAvatarBundle(id: number, mainName: string, commit: ActressAvatarCommit): void {
  mediaAssetStore.coordinateDatabaseChange(() => {
    const current = getActressAvatarRecord(id)
    if (!current) throw new Error('演员不存在')
    const displayBytes = Buffer.from(commit.displayImageBase64, 'base64')
    if (!mediaAssetStore.readImageDimensions(displayBytes)) throw new Error('头像展示图无效')
    const source = readCommitSource(commit, current.avatar_source_path)
    if (!source) throw new Error('缺少头像原图，请重新选择图片后再裁剪保存')
    const crop = parseAvatarCrop(JSON.stringify(commit.crop), source.fingerprint)
    if (!crop) throw new Error('头像裁剪参数无效')
    const changingSource = Boolean(
      commit.sourceImageBase64 || commit.sourceLocalPath || commit.sourceAssetPath
    )
    let sourcePath = current.avatar_source_path
    const currentMime = sourcePath && mediaAssetStore.isUsableImage(sourcePath)
      ? mediaAssetStore.readForServe(sourcePath).mime
      : null
    const storedFormatMismatch = currentMime !== mediaAssetStore.mimeFromExtension(source.extension)
    if (
      changingSource || !sourcePath ||
      sourceFingerprint(sourcePath) !== source.fingerprint || storedFormatMismatch
    ) {
      sourcePath = mediaAssetStore.importAvatarSource(
        mainName,
        id,
        source.bytes,
        source.extension
      ).relPath
    }
    const displayPath = mediaAssetStore.importAvatarDisplay(mainName, id, displayBytes)
    const result = updateActressAvatarRecord(id, {
      displayPath,
      sourcePath,
      cropJson: JSON.stringify(createAvatarCropV1({
        sourceFingerprint: source.fingerprint,
        zoom: crop.zoom,
        offsetX: crop.offsetX,
        offsetY: crop.offsetY,
        viewSize: crop.viewSize,
        outputSize: crop.outputSize
      }))
    })
    for (const storedPath of result.obsoletePaths) mediaAssetStore.deleteBestEffort(storedPath)
  })
}

export function editActressWithAssets(id: number, input: ActressEditInput): void {
  mediaAssetStore.coordinateDatabaseChange(() => getDb().transaction(() => {
    editActressRecord(id, input)
    const current = getActressAvatarRecord(id)
    if (!current) throw new Error('演员不存在')
    if (input.clearAvatar) {
      const result = updateActressAvatarRecord(id, {
        displayPath: null,
        sourcePath: null,
        cropJson: null
      })
      for (const storedPath of result.obsoletePaths) mediaAssetStore.deleteBestEffort(storedPath)
    } else if (input.avatar) {
      setActressAvatarBundle(id, current.main_name, input.avatar)
    } else if (input.avatarImageBase64 || input.avatarSourcePath) {
      const bytes = input.avatarImageBase64
        ? Buffer.from(input.avatarImageBase64, 'base64')
        : mediaAssetStore.readExternalFile(input.avatarSourcePath!)
      const extension = input.avatarSourcePath
        ? mediaAssetStore.extensionOf(input.avatarSourcePath)
        : '.jpg'
      const bundle = createDefaultAvatarBundle(id, current.main_name, bytes, extension)
      const result = updateActressAvatarRecord(id, bundle)
      for (const storedPath of result.obsoletePaths) mediaAssetStore.deleteBestEffort(storedPath)
    }
  })())
}

function mergeAvatarSelection(keepId: number, mergeId: number) {
  const keep = getActressAvatarRecord(keepId)
  const merge = getActressAvatarRecord(mergeId)
  if (!keep || !merge) throw new Error('演员不存在')
  const owner = mediaAssetStore.isUsableImage(keep.avatar_path)
    ? keep
    : mediaAssetStore.isUsableImage(merge.avatar_path)
      ? merge
      : null
  const sourceUsable = Boolean(owner?.avatar_source_path && mediaAssetStore.isUsableImage(owner.avatar_source_path))
  let cropJson: string | null = null
  if (owner?.avatar_crop_json && owner.avatar_source_path && sourceUsable) {
    const fingerprint = sourceFingerprint(owner.avatar_source_path)
    if (fingerprint && parseAvatarCrop(owner.avatar_crop_json, fingerprint)) {
      cropJson = owner.avatar_crop_json
    }
  }
  return { ownerId: owner?.id ?? null, sourceUsable, cropJson }
}

export function mergeActressesWithAssets(
  keepId: number,
  mergeId: number,
  mainNameFrom: ActressMergeMainNameFrom = 'keep',
  options?: { deferCleanup?: boolean }
) {
  const result = mergeActressRecords(keepId, mergeId, mainNameFrom, {
    avatar: mergeAvatarSelection(keepId, mergeId)
  })
  if (!options?.deferCleanup) {
    for (const storedPath of result.fileChanges.obsoletePaths) {
      mediaAssetStore.deleteBestEffort(storedPath)
    }
  }
  return result
}

function incomingMatchesExisting(
  current: ReturnType<typeof getActressAvatarRecord>,
  incomingPath: string | null
): boolean {
  if (!current || !incomingPath) return false
  const incoming = sourceFingerprint(incomingPath)
  if (!incoming) return false
  const existingPath = current.avatar_source_path && sourceFingerprint(current.avatar_source_path)
    ? current.avatar_source_path
    : current.avatar_path
  return Boolean(existingPath && sourceFingerprint(existingPath) === incoming)
}

function prepareScrapeAssetFacts(
  actressId: number,
  avatarRelPath: string | null,
  createBundle: boolean
): ActressScrapeAssetFacts {
  const current = getActressAvatarRecord(actressId)
  const currentAvatarUsable = Boolean(current?.avatar_path && mediaAssetStore.isUsableImage(current.avatar_path))
  const incomingAvatarUsable = Boolean(avatarRelPath && mediaAssetStore.isUsableImage(avatarRelPath))
  const matches = incomingAvatarUsable && incomingMatchesExisting(current, avatarRelPath)
  let preparedAvatar: ActressScrapeAssetFacts['preparedAvatar'] = null
  if (createBundle && current && avatarRelPath && incomingAvatarUsable && !matches) {
    const bytes = mediaAssetStore.readBytes(avatarRelPath)
    preparedAvatar = createDefaultAvatarBundle(
      actressId,
      current.main_name,
      bytes,
      mediaAssetStore.extensionOf(avatarRelPath)
    )
  }
  return { currentAvatarUsable, incomingAvatarUsable, incomingMatchesExisting: matches, preparedAvatar }
}

export function planActressScrapeResult(
  actressId: number,
  result: ActressScrapeResult,
  avatarRelPath: string | null,
  galleryAssets: GalleryAssetWriteInput[],
  fields?: ActressScrapeField[],
  mode: ActressScrapeUpdateMode = 'replace',
  options?: { releasedNameKeys?: readonly string[] }
) {
  return planActressScrapeResultRecord(
    actressId,
    result,
    avatarRelPath,
    galleryAssets,
    fields,
    mode,
    { ...options, assetFacts: prepareScrapeAssetFacts(actressId, avatarRelPath, false) }
  )
}

export function resolveEffectiveActressScrapeFields(
  actressId: number,
  fields: ActressScrapeField[],
  mode: ActressScrapeUpdateMode = 'replace'
): ActressScrapeField[] {
  const current = getActressAvatarRecord(actressId)
  const usable = Boolean(current?.avatar_path && mediaAssetStore.isUsableImage(current.avatar_path))
  return resolveEffectiveActressScrapeFieldsRecord(actressId, fields, mode, usable)
}

export function applyActressScrapeResult(
  actressId: number,
  result: ActressScrapeResult,
  avatarRelPath: string | null,
  galleryAssets: GalleryAssetWriteInput[],
  fields?: ActressScrapeField[],
  mode: ActressScrapeUpdateMode = 'replace',
  beforeCommit?: () => void,
  options?: { deferFileCleanup?: boolean }
) {
  return mediaAssetStore.coordinateDatabaseChange(() => {
    if (mode === 'fillEmpty') clearBrokenActressAvatarIfNeeded(actressId)
    const current = getActressAvatarRecord(actressId)
    const currentAvatarUsable = Boolean(
      current?.avatar_path && mediaAssetStore.isUsableImage(current.avatar_path)
    )
    const wantsAvatar = fields?.includes('avatar') ?? true
    const shouldPrepareBundle = wantsAvatar && (mode !== 'fillEmpty' || !currentAvatarUsable)
    const facts = prepareScrapeAssetFacts(actressId, avatarRelPath, shouldPrepareBundle)
    const applied = applyActressScrapeResultRecord(
      actressId,
      result,
      avatarRelPath,
      galleryAssets,
      fields,
      mode,
      beforeCommit,
      { assetFacts: facts }
    )
    if (avatarRelPath && !facts.incomingAvatarUsable) {
      applied.warnings.push('头像未应用：下载的头像不是有效图片')
    }
    if (!options?.deferFileCleanup) {
      for (const storedPath of applied.fileChanges?.obsoletePaths ?? []) {
        mediaAssetStore.deleteBestEffort(storedPath)
      }
    }
    if (avatarRelPath && (facts.incomingMatchesExisting || !applied.avatarApplied)) {
      mediaAssetStore.deleteBestEffort(avatarRelPath)
    }
    return applied
  })
}

export function adoptDownloadedAvatarIfMissing(id: number, downloadedPath: string): void {
  mediaAssetStore.coordinateDatabaseChange(() => {
    clearBrokenActressAvatarIfNeeded(id)
    const current = getActressAvatarRecord(id)
    if (!current || mediaAssetStore.isUsableImage(current.avatar_path)) {
      mediaAssetStore.deleteBestEffort(downloadedPath)
      return
    }
    const bytes = mediaAssetStore.readBytes(downloadedPath)
    const bundle = createDefaultAvatarBundle(
      id,
      current.main_name,
      bytes,
      mediaAssetStore.extensionOf(downloadedPath)
    )
    const result = updateActressAvatarRecord(id, bundle)
    for (const storedPath of [...result.obsoletePaths, downloadedPath]) {
      if (storedPath !== bundle.displayPath && storedPath !== bundle.sourcePath) {
        mediaAssetStore.deleteBestEffort(storedPath)
      }
    }
  })
}

export function upsertActressFromScrapeWithAssets(
  name: string,
  avatarPath: string | null,
  gender?: 'female' | 'male'
): number {
  const id = upsertActressRecord(name, null, gender)
  if (avatarPath) adoptDownloadedAvatarIfMissing(id, avatarPath)
  return id
}
