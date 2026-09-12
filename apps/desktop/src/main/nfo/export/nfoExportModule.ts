import { nativeImage } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { NFO_SAMPLE_BACKUP_DIRECTORY } from '@shared/nfoExportTypes'
import type {
  NfoExportFileKind,
  NfoExportPlanAction,
  NfoExportPlanFile,
  NfoExportPlanPreview,
  NfoExportPlanRequest,
  NfoExportReport,
  NfoExportReportItem
} from '@shared/nfoExportTypes'
import {
  authorizeMediaLibraryRootFile,
  createAuthorizedMediaLibraryRootFileInspector
} from '@library/scan/mediaLibraryRootFileGuard'
import { mediaAssetStore, type MediaAssetStore } from '@library/mediaAssetStore'
import {
  coverBasename,
  getNfoExportProfile,
  listUnrepresentedNfoFields,
  renderNfoExportDocument,
  type NfoExportVideoDocument
} from '@library/nfo/export/nfoExportProfiles'
import {
  nfoExportRepository,
  type NfoExportRepository,
  type NfoExportResourceSnapshot
} from '@library/nfo/export/nfoExportRepository'
import { sanitizeNfoExportMessage } from '@library/nfo/export/nfoExportSafety'
import { prepareCoverArtwork, renderCoverArtwork, type CoverArtworkRecipe, type CoverImageDecoder } from './nfoCoverArtwork'

interface FileFingerprint {
  state: 'missing' | 'file' | 'conflict'
  size?: number
  mtimeMs?: number
  hash?: string
  mode?: number
}

interface DirectoryIdentity {
  readonly device: string
  readonly inode: string
}

interface InternalPlanFile extends NfoExportPlanFile {
  resourceId: number
  videoId: number
  targetPath: string
  targetDirectoryPath: string
  targetDirectoryIdentity: DirectoryIdentity
  snapshotHash: string
  expectedTarget: FileFingerprint
  content: { type: 'nfo'; bytes: Buffer } | { type: 'asset'; storedPath: string; sourceHash: string; artwork?: CoverArtworkRecipe }
  convertToJpeg: boolean
}

export interface InternalNfoExportPlan {
  preview: NfoExportPlanPreview
  files: readonly InternalPlanFile[]
  createdAt: string
}

interface PlannedAsset {
  kind: Exclude<NfoExportFileKind, 'nfo'>
  storedPath: string
  sourceHash: string
  extension: string
  convertToJpeg: boolean
  targetDirectory: string
  targetBasename: string
  relativeReference: string
  bytes: number
  actorName?: string
  warning?: string
  artwork?: CoverArtworkRecipe
}

interface UnavailableAsset {
  kind: PlannedAsset['kind']
  storedPath: string
  targetDirectory: string
  targetBasename: string
  warning: string
  extension?: string
}

export interface NfoExportModuleDependencies {
  repository: NfoExportRepository
  assetStore: Pick<MediaAssetStore, 'readBytes' | 'detectImageExtension'>
  authorizeAnchor: typeof authorizeMediaLibraryRootFile
  createPlanAnchorInspector?: () => ReturnType<typeof createAuthorizedMediaLibraryRootFileInspector>
  now(): Date
  encodeImage?(bytes: Buffer, convertToJpeg: boolean): Buffer
  decodeCoverImage?: CoverImageDecoder
  writeAtomically?(targetPath: string, bytes: Buffer): void
}

const defaultDependencies: NfoExportModuleDependencies = {
  repository: nfoExportRepository,
  assetStore: mediaAssetStore,
  authorizeAnchor: authorizeMediaLibraryRootFile,
  createPlanAnchorInspector: createAuthorizedMediaLibraryRootFileInspector,
  now: () => new Date()
}

function digest(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function digestFile(targetPath: string): string {
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const handle = fs.openSync(targetPath, 'r')
  try {
    let offset = 0
    while (true) {
      const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, offset)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
  } finally {
    fs.closeSync(handle)
  }
  return hash.digest('hex')
}

function directoryIdentity(directoryPath: string): DirectoryIdentity {
  const stat = fs.statSync(directoryPath, { bigint: true })
  if (!stat.isDirectory()) throw new Error('导出目标目录不可用')
  return { device: stat.dev.toString(), inode: stat.ino.toString() }
}

function directoryIdentityKey(identity: DirectoryIdentity): string {
  return `${identity.device}:${identity.inode}`
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

function targetFingerprint(targetPath: string, expectedParentIdentity?: DirectoryIdentity): FileFingerprint {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { state: 'conflict' }
  let readPath = targetPath
  if (expectedParentIdentity) {
    readPath = fs.realpathSync.native(targetPath)
    if (!sameDirectoryIdentity(directoryIdentity(path.dirname(readPath)), expectedParentIdentity)) {
      throw new Error('导出目标越过媒体目录')
    }
  }
  return {
    state: 'file',
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    hash: digestFile(readPath),
    mode: stat.mode & 0o777
  }
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.state === right.state && left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.hash === right.hash && left.mode === right.mode
}

function samePlannedContent(
  left: InternalPlanFile['content'],
  right: InternalPlanFile['content']
): boolean {
  if (left.type !== right.type) return false
  if (left.type === 'nfo' && right.type === 'nfo') return left.bytes.equals(right.bytes)
  return left.type === 'asset' && right.type === 'asset' &&
    left.storedPath === right.storedPath && left.sourceHash === right.sourceHash &&
    JSON.stringify(left.artwork) === JSON.stringify(right.artwork)
}

function actionFor(fingerprint: FileFingerprint, replace: boolean): NfoExportPlanAction {
  if (fingerprint.state === 'conflict') return 'conflict'
  if (fingerprint.state === 'missing') return 'create'
  return replace ? 'replace' : 'skip-existing'
}

function safeFilename(value: string): string {
  // Kodi matches .actors filenames against actor names with ordinary spaces replaced.
  let cleaned = value.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001F]/gu, '_').trim().replace(/ /gu, '_')
  cleaned = cleaned.replace(/[. ]+$/gu, '_').slice(0, 120)
  if (!cleaned) return 'unnamed'
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(cleaned)) {
    return `_${cleaned}`.slice(0, 120)
  }
  return cleaned
}

function canonicalTargetName(value: string): string {
  return value.normalize('NFC').toLowerCase()
}

type PlannedTargetParent =
  | { readonly exists: false; readonly realPath: string }
  | { readonly exists: true; readonly realPath: string; readonly identity: DirectoryIdentity }

/**
 * Inspect a target using the canonical media directory returned by the anchor inspection.
 * Direct targets need no additional directory lookup; supported child directories are
 * resolved once and then shared by every image planned beneath them.
 */
function planTargetFingerprint(
  targetPath: string,
  anchorDirectoryPath: string,
  anchorDirectoryRealPath: string,
  anchorDirectoryIdentity: DirectoryIdentity,
  parents: Map<string, PlannedTargetParent>
): FileFingerprint {
  const parent = path.dirname(targetPath)
  if (parent === anchorDirectoryPath) {
    return targetFingerprint(
      path.join(anchorDirectoryRealPath, path.basename(targetPath)),
      anchorDirectoryIdentity
    )
  }
  if (path.dirname(parent) !== anchorDirectoryPath ||
    !['.actors', NFO_SAMPLE_BACKUP_DIRECTORY].includes(path.basename(parent))) {
    throw new Error('导出子目录不安全')
  }

  const cacheKey = `${directoryIdentityKey(anchorDirectoryIdentity)}\0${canonicalTargetName(path.basename(parent))}`
  let inspected = parents.get(cacheKey)
  if (!inspected) {
    let stat: fs.Stats | null = null
    try {
      stat = fs.lstatSync(parent)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!stat) {
      inspected = {
        exists: false,
        realPath: path.join(anchorDirectoryRealPath, path.basename(parent))
      }
    } else {
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('导出子目录发生冲突')
      }
      const realPath = fs.realpathSync.native(parent)
      if (!sameDirectoryIdentity(directoryIdentity(path.dirname(realPath)), anchorDirectoryIdentity)) {
        throw new Error('导出目标越过媒体目录')
      }
      inspected = { exists: true, realPath, identity: directoryIdentity(realPath) }
    }
    parents.set(cacheKey, inspected)
  }

  if (!inspected.exists) return { state: 'missing' }
  return targetFingerprint(
    path.join(inspected.realPath, path.basename(targetPath)),
    inspected.identity
  )
}

function assetExtension(
  bytes: Buffer,
  assetStore: NfoExportModuleDependencies['assetStore']
): { extension: string; convertToJpeg: boolean } | null {
  const detected = assetStore.detectImageExtension(bytes)?.toLowerCase()
  if (detected === '.jpg' || detected === '.jpeg') return { extension: '.jpg', convertToJpeg: false }
  if (detected === '.png') return { extension: '.png', convertToJpeg: false }
  if (detected === '.webp') return { extension: '.jpg', convertToJpeg: true }
  return null
}

function imageBytesForWrite(bytes: Buffer, convertToJpeg: boolean): Buffer {
  if (!convertToJpeg) return bytes
  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) throw new Error('图片无法解码')
  return image.toJPEG(85)
}

function snapshotPayload(snapshot: NfoExportResourceSnapshot): object {
  return {
    resourceId: snapshot.resourceId,
    libraryId: snapshot.libraryId,
    libraryRevision: snapshot.libraryRevision,
    videoId: snapshot.videoId,
    rootId: snapshot.rootId,
    kind: snapshot.kind,
    anchorPath: snapshot.anchorPath,
    resourceSize: snapshot.resourceSize,
    resourceMtime: snapshot.resourceMtime,
    code: snapshot.code,
    title: snapshot.title,
    originalTitle: snapshot.originalTitle,
    summary: snapshot.summary,
    coverPath: snapshot.coverPath,
    posterPath: snapshot.posterPath,
    releaseDate: snapshot.releaseDate,
    durationSeconds: snapshot.durationSeconds,
    updatedAt: snapshot.updatedAt,
    maker: snapshot.maker,
    publisher: snapshot.publisher,
    series: snapshot.series,
    director: snapshot.director,
    tags: snapshot.tags,
    actors: snapshot.actors,
    ratings: snapshot.ratings,
    identities: snapshot.identities,
    samples: snapshot.samples,
    root: snapshot.root && {
      id: snapshot.root.id,
      libraryId: snapshot.root.libraryId,
      path: snapshot.root.path,
      realPath: snapshot.root.realPath,
      state: snapshot.root.state,
      updatedAt: snapshot.root.updatedAt
    }
  }
}

// Metadata and anchor changes invalidate the resource. Image bytes are checked
// against each asset item's sourceHash so one failed image cannot invalidate siblings.
function snapshotHash(snapshot: NfoExportResourceSnapshot, inspectedAnchor?: fs.Stats): string {
  const anchor = inspectedAnchor ?? (snapshot.anchorPath ? fs.statSync(snapshot.anchorPath) : null)
  return digest(JSON.stringify({
    snapshot: snapshotPayload(snapshot),
    anchor: anchor && {
      dev: String(anchor.dev),
      ino: String(anchor.ino),
      size: anchor.size,
      mtimeMs: anchor.mtimeMs
    }
  }))
}

function createAsset(
  kind: PlannedAsset['kind'],
  storedPath: string,
  targetDirectory: string,
  targetBasename: string,
  relativeDirectory: string,
  store: NfoExportModuleDependencies['assetStore'],
  actorName?: string
): PlannedAsset | null {
  const bytes = store.readBytes(storedPath)
  const image = assetExtension(bytes, store)
  if (!image) return null
  const filename = `${targetBasename}${image.extension}`
  return {
    kind,
    storedPath,
    sourceHash: digest(bytes),
    extension: image.extension,
    convertToJpeg: image.convertToJpeg,
    targetDirectory,
    targetBasename,
    relativeReference: path.posix.join(relativeDirectory, filename),
    bytes: bytes.byteLength,
    ...(actorName ? { actorName } : {})
  }
}

function makeDocument(
  snapshot: NfoExportResourceSnapshot,
  assets: readonly PlannedAsset[],
  collidingActorBasenames: ReadonlySet<string>
): NfoExportVideoDocument {
  const cover = assets.find((asset) => asset.kind === 'cover')
  const fanart = assets.find((asset) => asset.kind === 'fanart')
  const actorThumbs = new Map(
    assets.filter((asset) =>
      asset.kind === 'actor-avatar' && asset.actorName &&
      !collidingActorBasenames.has(asset.targetBasename)
    ).map((asset) => [asset.actorName!, asset.relativeReference])
  )
  return {
    code: snapshot.code,
    title: snapshot.title,
    originalTitle: snapshot.originalTitle,
    summary: snapshot.summary,
    releaseDate: snapshot.releaseDate,
    maker: snapshot.maker,
    publisher: snapshot.publisher,
    series: snapshot.series,
    director: snapshot.director,
    durationSeconds: snapshot.durationSeconds,
    tags: snapshot.tags,
    actors: snapshot.actors.map((actor) => ({
      name: actor.name,
      gender: actor.gender,
      thumbReference: actorThumbs.get(actor.name)
    })),
    ratings: snapshot.ratings,
    identities: snapshot.identities,
    coverReference: cover?.relativeReference,
    landscapeReference: assets.find((asset) => asset.kind === 'landscape')?.relativeReference,
    fanartReference: fanart?.relativeReference
  }
}

export class NfoExportModule {
  constructor(private readonly deps: NfoExportModuleDependencies = defaultDependencies) {}

  async plan(request: NfoExportPlanRequest): Promise<InternalNfoExportPlan> {
    const profile = getNfoExportProfile(request.profileId)
    const files: InternalPlanFile[] = []
    const warnings: string[] = []
    const plannedTargets = new Map<string, InternalPlanFile>()
    const preparedCovers = new Map<string, ReturnType<typeof prepareCoverArtwork>>()
    const documents = new Map<InternalPlanFile, {
      snapshot: NfoExportResourceSnapshot
      assets: PlannedAsset[]
      collidingActorBasenames: Set<string>
    }>()
    const snapshots = this.deps.repository.listResourceSnapshots(request.libraryIds)
    let skippedNoAnchorCount = 0
    let sampleCount = 0
    let resourceCount = 0
    const exportedVideoIds = new Set<number>()
    const targetVideoCodes = new Map<string, Map<string, number>>()
    const inspectPlanAnchor = this.deps.createPlanAnchorInspector?.()
    const plannedTargetParents = new Map<string, PlannedTargetParent>()

    for (const snapshot of snapshots) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (!snapshot.anchorPath || snapshot.rootId == null || !snapshot.root) {
        skippedNoAnchorCount += 1
        continue
      }
      let anchorStat: fs.Stats
      let targetDirectoryRealPath: string
      let targetDirectoryIdentity: DirectoryIdentity
      try {
        if (inspectPlanAnchor) {
          const inspected = inspectPlanAnchor(
            snapshot.libraryId, snapshot.rootId, snapshot.anchorPath, snapshot.root
          )
          anchorStat = inspected.stat
          targetDirectoryRealPath = path.dirname(inspected.fileRealPath)
        } else {
          this.deps.authorizeAnchor(snapshot.libraryId, snapshot.rootId, snapshot.anchorPath, snapshot.root)
          const anchorRealPath = fs.realpathSync.native(snapshot.anchorPath)
          anchorStat = fs.statSync(anchorRealPath)
          targetDirectoryRealPath = path.dirname(anchorRealPath)
        }
        targetDirectoryIdentity = directoryIdentity(targetDirectoryRealPath)
      } catch {
        warnings.push(`${snapshot.code}：本地资源锚点已不可用，已跳过。`)
        continue
      }
      if (!anchorStat.isFile()) {
        warnings.push(`${snapshot.code}：本地资源锚点不是普通文件，已跳过。`)
        continue
      }
      const targetDirectory = path.dirname(snapshot.anchorPath)
      const stem = path.parse(snapshot.anchorPath).name
      let sourceSnapshotHash: string
      try {
        sourceSnapshotHash = snapshotHash(snapshot, anchorStat)
      } catch {
        warnings.push(`${snapshot.code}：本地资源锚点在规划期间发生变化，已跳过。`)
        continue
      }
      resourceCount += 1
      exportedVideoIds.add(snapshot.videoId)
      const assets: PlannedAsset[] = []
      const unavailableAssets: UnavailableAsset[] = []
      const collidingActorBasenames = new Set<string>()
      const addAsset = (
        kind: PlannedAsset['kind'], storedPath: string | undefined,
        directory: string, basename: string, relativeDirectory = '', actorName?: string
      ): void => {
        if (!storedPath) return
        try {
          const asset = createAsset(
            kind, storedPath, directory, basename, relativeDirectory, this.deps.assetStore, actorName
          )
          if (asset) assets.push(asset)
          else {
            const warning = `${snapshot.code}：${kind} 不是支持的图片格式，已跳过。`
            warnings.push(warning)
            unavailableAssets.push({ kind, storedPath, targetDirectory: directory, targetBasename: basename, warning })
          }
        } catch {
          const warning = `${snapshot.code}：${kind} 图片不可读取，已跳过。`
          warnings.push(warning)
          unavailableAssets.push({ kind, storedPath, targetDirectory: directory, targetBasename: basename, warning })
        }
      }
      if (request.includeCover && snapshot.coverPath) {
        const basename = coverBasename(request.profileId, stem)
        try {
          const source = this.deps.assetStore.readBytes(snapshot.coverPath)
          const extension = this.deps.assetStore.detectImageExtension(source)?.toLowerCase() ?? ''
          const sourceHash = digest(source)
          const artwork = preparedCovers.get(sourceHash) ?? prepareCoverArtwork(source, extension, this.deps.decodeCoverImage)
          preparedCovers.set(sourceHash, artwork)
          for (const item of artwork) {
            const targetBasename = item.kind === 'cover' ? basename : `${stem}-landscape`
            if (!item.recipe) {
              const warning = `${snapshot.code}：${item.warning}`
              unavailableAssets.push({ kind: item.kind, storedPath: snapshot.coverPath, targetDirectory, targetBasename, extension: item.extension, warning })
              warnings.push(warning)
              continue
            }
            assets.push({
              kind: item.kind, storedPath: snapshot.coverPath, sourceHash,
              extension: item.extension, convertToJpeg: false, artwork: item.recipe,
              targetDirectory, targetBasename, relativeReference: `${targetBasename}${item.extension}`,
              bytes: item.bytes
            })
            if (item.warning) warnings.push(`${snapshot.code}：${item.warning}`)
            if (['.jpg', '.jpeg', '.png'].some((ext) => ext !== item.extension && fs.existsSync(path.join(targetDirectory, `${targetBasename}${ext}`)))) {
              warnings.push(`${snapshot.code}：${targetBasename} 存在其他扩展名的图片，播放器可能优先使用旧图；请手动检查。`)
            }
          }
        } catch (error) {
          const warning = `${snapshot.code}：封面不可用（${sanitizeNfoExportMessage(error)}），不会写入或引用海报。`
          warnings.push(warning)
          unavailableAssets.push({ kind: 'cover', storedPath: snapshot.coverPath, targetDirectory, targetBasename: basename, warning })
        }
      }
      if (request.includeFanart) {
        if (!snapshot.posterPath) warnings.push(`${snapshot.code}：没有可导出的 fanart。`)
        addAsset('fanart', snapshot.posterPath, targetDirectory, `${stem}-fanart`)
      }
      if (request.includeSamples) {
        snapshot.samples.forEach((storedPath, index) => {
          addAsset('sample', storedPath, path.join(targetDirectory, NFO_SAMPLE_BACKUP_DIRECTORY),
            `${stem}-${String(index + 1).padStart(3, '0')}`, NFO_SAMPLE_BACKUP_DIRECTORY)
        })
        sampleCount += assets.filter((asset) => asset.kind === 'sample').length
      }
      if (request.includeActorAvatars) {
        const missingAvatarCount = snapshot.actors.filter((actor) => !actor.avatarPath).length
        if (missingAvatarCount > 0) {
          warnings.push(`${snapshot.code}：${missingAvatarCount} 位演员没有可导出的头像。`)
        }
        const basenameCounts = new Map<string, number>()
        for (const actor of snapshot.actors.filter((item) => item.avatarPath)) {
          const basename = safeFilename(actor.name)
          const canonical = canonicalTargetName(basename)
          basenameCounts.set(canonical, (basenameCounts.get(canonical) ?? 0) + 1)
        }
        for (const actor of snapshot.actors.filter((item) => item.avatarPath)) {
          const basename = safeFilename(actor.name)
          if ((basenameCounts.get(canonicalTargetName(basename)) ?? 0) > 1) {
            collidingActorBasenames.add(basename)
          }
        }
        if (collidingActorBasenames.size > 0) {
          warnings.push(`${snapshot.code}：演员头像目标发生碰撞，相关头像不会写入或引用。`)
        }
        for (const actor of snapshot.actors) {
          addAsset('actor-avatar', actor.avatarPath, path.join(targetDirectory, '.actors'),
            safeFilename(actor.name), '.actors', actor.name)
        }
      }
      const document = makeDocument(snapshot, assets, collidingActorBasenames)
      const unrepresentedFields = listUnrepresentedNfoFields(request.profileId, document)
      if (unrepresentedFields.length > 0) {
        warnings.push(`${snapshot.code}：所选 profile 不表示这些已有字段：${unrepresentedFields.join('、')}。`)
      }
      const nfoBytes = renderNfoExportDocument(request.profileId, document)
      const descriptors: Array<{
        kind: NfoExportFileKind
        targetPath: string
        bytes: number
        content: InternalPlanFile['content']
        convertToJpeg: boolean
        forceConflict?: boolean
      }> = [{
        kind: 'nfo',
        targetPath: path.join(targetDirectory, `${stem}.nfo`),
        bytes: nfoBytes.byteLength,
        content: { type: 'nfo', bytes: nfoBytes },
        convertToJpeg: false
      }, ...assets.map((asset) => ({
        kind: asset.kind,
        targetPath: path.join(asset.targetDirectory, `${asset.targetBasename}${asset.extension}`),
        bytes: asset.bytes,
        content: { type: 'asset' as const, storedPath: asset.storedPath, sourceHash: asset.sourceHash, ...(asset.artwork ? { artwork: asset.artwork } : {}) },
        convertToJpeg: asset.convertToJpeg,
        forceConflict: asset.kind === 'actor-avatar' && collidingActorBasenames.has(asset.targetBasename)
      })), ...unavailableAssets.map((asset) => ({
        kind: asset.kind,
        targetPath: path.join(asset.targetDirectory, `${asset.targetBasename}${asset.extension ?? '.jpg'}`),
        bytes: 0,
        content: { type: 'asset' as const, storedPath: asset.storedPath, sourceHash: '' },
        convertToJpeg: false,
        unavailable: true,
        warning: asset.warning
      }))]

      for (const descriptor of descriptors) {
        const key = `${directoryIdentityKey(targetDirectoryIdentity)}\0${canonicalTargetName(
          path.relative(targetDirectory, descriptor.targetPath)
        )}`
        const existingPlan = plannedTargets.get(key)
        if (existingPlan) {
          if (descriptor.forceConflict ||
            (existingPlan.videoId !== snapshot.videoId && descriptor.kind !== 'actor-avatar') ||
            !samePlannedContent(existingPlan.content, descriptor.content)) {
            existingPlan.action = 'conflict'
            warnings.push(`${snapshot.code}：不同内容计划写入同一目标，已标为冲突。`)
          }
          continue
        }
        let existing: FileFingerprint
        try {
          existing = planTargetFingerprint(
            descriptor.targetPath,
            targetDirectory,
            targetDirectoryRealPath,
            targetDirectoryIdentity,
            plannedTargetParents
          )
        } catch {
          existing = { state: 'conflict' }
          warnings.push(`${snapshot.code}：导出目标目录不安全，已标为冲突。`)
        }
        const file: InternalPlanFile = {
          id: crypto.randomUUID(),
          resourceId: snapshot.resourceId,
          videoId: snapshot.videoId,
          kind: descriptor.kind,
          targetPath: descriptor.targetPath,
          targetDirectoryPath: targetDirectory,
          targetDirectoryIdentity,
          displayName: `${snapshot.code} / ${path.relative(targetDirectory, descriptor.targetPath)}`,
          videoCode: snapshot.code,
          action: 'unavailable' in descriptor && descriptor.unavailable
            ? 'unavailable'
            : descriptor.forceConflict
              ? 'conflict'
              : actionFor(existing, request.collisionPolicy === 'replace'),
          bytes: descriptor.bytes,
          snapshotHash: sourceSnapshotHash,
          expectedTarget: existing,
          content: descriptor.content,
          convertToJpeg: descriptor.convertToJpeg
        }
        if ('warning' in descriptor && typeof descriptor.warning === 'string') {
          file.warning = descriptor.warning
        }
        if (file.kind === 'cover' && file.action === 'skip-existing') {
          file.warning = `${snapshot.code}：已有海报将保留；要更新为本次导出的封面，请选择覆盖后重新预览。`
          warnings.push(file.warning)
        }
        plannedTargets.set(key, file)
        files.push(file)
        if (file.kind === 'nfo') documents.set(file, { snapshot, assets, collidingActorBasenames })
      }
      const physicalDirectoryKey = directoryIdentityKey(targetDirectoryIdentity)
      const codes = targetVideoCodes.get(physicalDirectoryKey) ?? new Map<string, number>()
      const normalizedCode = snapshot.code.trim().toUpperCase()
      const existingVideoId = codes.get(normalizedCode)
      if (existingVideoId != null && existingVideoId !== snapshot.videoId) {
        warnings.push(`${snapshot.code}：同一物理目录存在相同规范化番号的不同影片。`)
      }
      codes.set(normalizedCode, snapshot.videoId)
      targetVideoCodes.set(physicalDirectoryKey, codes)
    }
    // A later resource can introduce an artwork collision in a shared directory.
    // Finalize references only after every target has been classified.
    for (const [file, document] of documents) {
      const assets = document.assets.filter((asset) => {
        const key = `${directoryIdentityKey(file.targetDirectoryIdentity)}\0${canonicalTargetName(
          path.relative(file.targetDirectoryPath,
            path.join(asset.targetDirectory, `${asset.targetBasename}${asset.extension}`))
        )}`
        return plannedTargets.get(key)?.action !== 'conflict'
      })
      const bytes = renderNfoExportDocument(request.profileId,
        makeDocument(document.snapshot, assets, document.collidingActorBasenames))
      file.content = { type: 'nfo', bytes }
      file.bytes = bytes.byteLength
    }
    if (profile.warning) warnings.unshift(profile.warning)
    const count = (action: NfoExportPlanAction): number => files.filter((file) => file.action === action).length
    const publicFiles = files.map(({ resourceId: _a, videoId: _b, targetPath: _c, targetDirectoryPath: _d,
      targetDirectoryIdentity: _e, snapshotHash: _f, expectedTarget: _g,
      content: _h, convertToJpeg: _i, ...file }) =>
      Object.freeze(file)
    )
    const preview: NfoExportPlanPreview = {
      planId: crypto.randomUUID(),
      request: Object.freeze({ ...request, libraryIds: Object.freeze([...request.libraryIds]) }) as NfoExportPlanRequest,
      summary: Object.freeze({
        videoCount: exportedVideoIds.size,
        resourceCount,
        fileCount: files.length,
        createCount: count('create'),
        replaceCount: count('replace'),
        skipCount: count('skip-existing'),
        conflictCount: count('conflict'),
        unavailableCount: count('unavailable'),
        skippedNoAnchorCount,
        warningCount: warnings.length,
        sampleCount,
        estimatedBytes: files
          .filter((file) => file.action === 'create' || file.action === 'replace')
          .reduce((total, file) => total + (file.bytes ?? 0), 0)
      }),
      files: Object.freeze(publicFiles) as unknown as NfoExportPlanFile[],
      warnings: Object.freeze([...warnings]) as unknown as string[]
    }
    for (const file of files) {
      Object.freeze(file.content)
      Object.freeze(file.expectedTarget)
      Object.freeze(file.targetDirectoryIdentity)
      Object.freeze(file)
    }
    Object.freeze(preview)
    return Object.freeze({
      preview,
      files: Object.freeze(files),
      createdAt: this.deps.now().toISOString()
    })
  }

  async apply(
    plan: InternalNfoExportPlan,
    taskId: string,
    signal: { isTerminated(): boolean },
    onProgress: (completed: number, total: number, current?: NfoExportPlanFile) => void
  ): Promise<NfoExportReport> {
    const startedAt = this.deps.now().toISOString()
    const items: NfoExportReportItem[] = []
    let completed = 0
    for (const file of plan.files) {
      if (signal.isTerminated()) break
      onProgress(completed, plan.files.length, file)
      const base = { id: file.id, kind: file.kind, displayName: file.displayName, videoCode: file.videoCode }
      if (file.action === 'conflict' || file.action === 'unavailable') {
        items.push({ ...base, disposition: file.action })
        completed += 1
        onProgress(completed, plan.files.length)
        await new Promise<void>((resolve) => setImmediate(resolve))
        continue
      }
      try {
        const current = this.deps.repository.getResourceSnapshot(file.resourceId)
        if (!current || !current.anchorPath || current.rootId == null || !current.root) {
          items.push({ ...base, disposition: 'stale-plan', message: '来源资源已变化' })
          completed += 1
          onProgress(completed, plan.files.length)
          await new Promise<void>((resolve) => setImmediate(resolve))
          continue
        }
        this.deps.authorizeAnchor(current.libraryId, current.rootId, current.anchorPath, current.root)
        const currentAnchorRealPath = fs.realpathSync.native(current.anchorPath)
        const currentDir = path.dirname(currentAnchorRealPath)
        const currentAnchorStat = fs.statSync(currentAnchorRealPath)
        const currentDirectoryIdentity = directoryIdentity(currentDir)
        const staleReason = !sameDirectoryIdentity(currentDirectoryIdentity, file.targetDirectoryIdentity)
          ? '导出目标目录在计划后发生变化'
          : snapshotHash(current, currentAnchorStat) !== file.snapshotHash
            ? '来源资源在计划后发生变化'
            : null
        if (staleReason) {
          items.push({ ...base, disposition: 'stale-plan', message: staleReason })
          completed += 1
          onProgress(completed, plan.files.length)
          await new Promise<void>((resolve) => setImmediate(resolve))
          continue
        }
        try {
          validateSafeTargetParent(
            file.targetPath, file.targetDirectoryPath, file.targetDirectoryIdentity, false
          )
        } catch {
          items.push({ ...base, disposition: 'stale-plan', message: '导出目标目录在计划后发生变化' })
          completed += 1
          onProgress(completed, plan.files.length)
          await new Promise<void>((resolve) => setImmediate(resolve))
          continue
        }
        if (!sameFingerprint(targetFingerprint(file.targetPath), file.expectedTarget)) {
          items.push({ ...base, disposition: 'stale-plan', message: '来源或目标在计划后发生变化' })
          completed += 1
          onProgress(completed, plan.files.length)
          await new Promise<void>((resolve) => setImmediate(resolve))
          continue
        }
        if (file.action === 'skip-existing') {
          items.push({ ...base, disposition: 'skipped-existing' })
          completed += 1
          onProgress(completed, plan.files.length)
          await new Promise<void>((resolve) => setImmediate(resolve))
          continue
        }
        const bytes = file.content.type === 'nfo'
          ? file.content.bytes
          : (() => {
              const source = this.deps.assetStore.readBytes(file.content.storedPath)
              if (digest(source) !== file.content.sourceHash) throw new Error('图片来源已变化')
              if (file.content.artwork) return renderCoverArtwork(source, file.content.artwork, this.deps.decodeCoverImage)
              return (this.deps.encodeImage ?? imageBytesForWrite)(source, file.convertToJpeg)
            })()
        validateSafeTargetParent(
          file.targetPath, file.targetDirectoryPath, file.targetDirectoryIdentity, true
        )
        ;(this.deps.writeAtomically ?? atomicWrite)(file.targetPath, bytes)
        items.push({ ...base, disposition: 'written' })
      } catch (error) {
        const message = sanitizeNfoExportMessage(error)
        items.push({
          ...base,
          disposition: /已变化|not found|ENOENT/iu.test(message) ? 'stale-plan' : 'failed',
          message
        })
      }
      completed += 1
      onProgress(completed, plan.files.length)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    if (signal.isTerminated()) {
      for (const file of plan.files.slice(completed)) {
        items.push({
          id: file.id,
          kind: file.kind,
          displayName: file.displayName,
          videoCode: file.videoCode,
          disposition: 'cancelled'
        })
      }
    }
    return {
      taskId,
      startedAt,
      finishedAt: this.deps.now().toISOString(),
      terminated: signal.isTerminated(),
      writtenCount: items.filter((item) => item.disposition === 'written').length,
      skippedCount: items.filter((item) => item.disposition === 'skipped-existing' || item.disposition === 'cancelled').length,
      failedCount: items.filter((item) => ['failed', 'stale-plan', 'conflict', 'unavailable'].includes(item.disposition)).length,
      items
    }
  }
}

function atomicWrite(targetPath: string, bytes: Buffer): void {
  const directory = path.dirname(targetPath)
  const temporary = path.join(directory, `.${path.basename(targetPath)}.javdex-${crypto.randomUUID()}.tmp`)
  let handle: number | null = null
  let existingMode: number | null = null
  try {
    const existing = fs.lstatSync(targetPath)
    if (existing.isFile() && !existing.isSymbolicLink()) existingMode = existing.mode & 0o777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    handle = fs.openSync(temporary, 'wx', existingMode ?? 0o666)
    if (existingMode != null) fs.fchmodSync(handle, existingMode)
    fs.writeFileSync(handle, bytes)
    fs.fsyncSync(handle)
    fs.closeSync(handle)
    handle = null
    fs.renameSync(temporary, targetPath)
    if (process.platform !== 'win32') {
      const directoryHandle = fs.openSync(directory, 'r')
      try { fs.fsyncSync(directoryHandle) } finally { fs.closeSync(directoryHandle) }
    }
  } finally {
    if (handle != null) fs.closeSync(handle)
    fs.rmSync(temporary, { force: true })
  }
}

function validateSafeTargetParent(
  targetPath: string,
  anchorDirectoryPath: string,
  anchorDirectoryIdentity: DirectoryIdentity,
  createMissing: boolean
): void {
  const parent = path.dirname(targetPath)
  const currentAnchorDirectory = fs.realpathSync.native(anchorDirectoryPath)
  if (!sameDirectoryIdentity(directoryIdentity(currentAnchorDirectory), anchorDirectoryIdentity)) {
    throw new Error('媒体目录已变化')
  }
  if (parent !== anchorDirectoryPath) {
    let stat: fs.Stats | null = null
    try { stat = fs.lstatSync(parent) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error('导出子目录发生冲突')
    }
    if (!stat) {
      if (path.dirname(parent) !== anchorDirectoryPath ||
        !['.actors', NFO_SAMPLE_BACKUP_DIRECTORY].includes(path.basename(parent))) {
        throw new Error('导出子目录不安全')
      }
      if (createMissing) fs.mkdirSync(parent)
      else return
    }
  }
  const realParent = fs.realpathSync.native(parent)
  if (parent !== anchorDirectoryPath &&
    !sameDirectoryIdentity(directoryIdentity(path.dirname(realParent)), anchorDirectoryIdentity)) {
    throw new Error('导出目标越过媒体目录')
  }
}

export const nfoExportModule = new NfoExportModule()
