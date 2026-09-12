import fs from 'node:fs'
import path from 'node:path'
import { NFO_SAMPLE_BACKUP_DIRECTORY } from '@shared/nfoExportTypes'
import type { ActressGender } from '@shared/actressTypes'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import type { ScrapeResult, VideoScrapeField } from '@shared/videoScrapeTypes'
import { normalizeVideoCode } from '@shared/videoCode'
import {
  LOCAL_NFO_SOURCE_ID,
  LOCAL_NFO_SOURCE_NAME
} from '@shared/videoMetadataSourceConstants'
import { findActressByNameOrAlias, getActressDetail } from '../db/actressRepo'
import { getDb } from '../db/database'
import { getMediaLibraryRoot } from '../db/mediaLibraryRepo'
import { isVideoFile, parseCode } from '../scanner/codeParser'
import { isStrmFile } from '../scanner/strmParser'
import { authorizeMediaLibraryRootFile } from '../services/mediaLibraryRootFileGuard'
import { createNfoFileStore, type NfoFileStore } from '../nfo/nfoFileStore'
import { parseNfoArtifact, type NormalizedNfoArtifact } from '../nfo/nfoArtifactCodec'
import { summarizeDirectoryVideoCodes, type DirectoryVideoIdentityInput } from '../nfo/directoryVideoIdentity'
import { NfoDirectoryCache } from './nfoDirectoryCache'
import { indexNfoSidecars, locateNfoSidecar, sameLogicalCode } from '../nfo/nfoSidecarLocator'
import { projectVideoScrapeResult } from '../scrapers/videoScrapeFieldProjection'
import type {
  MetadataAssetRef,
  MetadataCandidateBatch,
  VideoMetadataCandidate,
  VideoMetadataSource,
  VideoMetadataSourceDescriptor,
  VideoMetadataSourceRequest
} from './types'

export const LOCAL_NFO_SUPPORTED_FIELDS = [
  'title',
  'summary',
  'cover',
  'releaseDate',
  'maker',
  'publisher',
  'series',
  'director',
  'duration',
  'actressesFemale',
  'actressesMale',
  'tags',
  'rating',
  'samples'
] as const satisfies readonly VideoScrapeField[]

export interface LocalNfoAnchor {
  root: Readonly<MediaLibraryRoot>
  anchorPath: string
  directoryVideoCodes: DirectoryVideoIdentityInput
  directorySidecars?: ReadonlyMap<string, string>
}

export interface LocalNfoSourceAdapterOptions {
  listAnchors: (videoId: number) => LocalNfoAnchor[] | Promise<LocalNfoAnchor[]>
  fileStore: NfoFileStore
  findExistingActorGender: (name: string) => ActressGender | null
}

export interface LocalNfoIdentityInspection {
  status: 'missing' | 'warning' | 'found'
  code: string | null
  warnings: string[]
}

const naturalOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

function directoryScopeKey(root: Readonly<MediaLibraryRoot>, anchorPath: string): string {
  return JSON.stringify([root.libraryId, root.id, path.dirname(anchorPath)])
}

function listProductionAnchors(videoId: number): LocalNfoAnchor[] {
  const rows = getDb()
    .prepare(`
      SELECT library_id, root_id,
             CASE WHEN kind = 'local' THEN locator ELSE strm_source_path END AS anchor_path
        FROM video_resources
       WHERE video_id = ? AND root_id IS NOT NULL
         AND (kind = 'local' OR strm_source_path IS NOT NULL)
       ORDER BY library_id, id
    `)
    .all(videoId) as Array<{ library_id: number; root_id: number; anchor_path: string | null }>
  const anchors: LocalNfoAnchor[] = []
  const directories = new NfoDirectoryCache<{
    directoryVideoCodes: DirectoryVideoIdentityInput
    directorySidecars?: ReadonlyMap<string, string>
  }>()
  for (const row of rows) {
    if (!row.anchor_path) continue
    const root = getMediaLibraryRoot(row.library_id, row.root_id)
    if (!root || root.state !== 'active') continue
    const key = directoryScopeKey(root, row.anchor_path)
    let context = directories.get(key)
    if (!context) {
      try {
        const names = fs.readdirSync(path.dirname(row.anchor_path))
        const summary = summarizeDirectoryVideoCodes((function* () {
          // Preserve the manual helper's name-only filter, including directory names.
          for (const name of names) {
            if (isVideoFile(name) || isStrmFile(name)) yield parseCode(path.basename(name, path.extname(name)))
          }
        })())
        const sidecars = indexNfoSidecars(names)
        const snapshot = { directoryVideoCodes: summary, directorySidecars: sidecars }
        context = directories.admit(key, snapshot, sidecars, summary.normalizedCode)
          ? snapshot
          : { directoryVideoCodes: summary }
        // Rejected maps must not escape through anchors and defeat the aggregate budget.
      } catch {
        // Failed reads are not snapshots: the next anchor and collect may retry.
      }
    }
    anchors.push({
      root,
      anchorPath: row.anchor_path,
      ...(context ?? { directoryVideoCodes: [parseCode(path.basename(row.anchor_path, path.extname(row.anchor_path)))] })
    })
  }
  return anchors
}

function findExistingActorGender(name: string): ActressGender | null {
  const actressId = findActressByNameOrAlias(name)
  if (!actressId) return null
  return getActressDetail(actressId)?.gender ?? null
}

export function createDefaultNfoFileStore(): NfoFileStore {
  return createNfoFileStore({
    authorize: (filePath, root) => {
      authorizeMediaLibraryRootFile(root.libraryId, root.id, filePath, root)
    }
  })
}

const defaultNfoFileStore = createDefaultNfoFileStore()

export function getDefaultNfoFileStore(): NfoFileStore {
  return defaultNfoFileStore
}

export function createDefaultLocalNfoSourceAdapter(
  fileStore = defaultNfoFileStore
): LocalNfoSourceAdapter {
  return new LocalNfoSourceAdapter({
    listAnchors: listProductionAnchors,
    fileStore,
    findExistingActorGender
  })
}

function referencePath(directory: string, reference: string): string {
  const normalized = reference.replaceAll('\\', path.sep)
  return path.isAbsolute(normalized) ? normalized : path.resolve(directory, normalized)
}

function filesByStem(directory: string, stems: string[]): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(directory)
  } catch {
    return []
  }
  const normalizedStems = new Map(stems.map((stem, position) => [stem.toLowerCase(), position]))
  return names
    .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .map((name) => ({
      name,
      position: normalizedStems.get(path.basename(name, path.extname(name)).toLowerCase())
    }))
    .filter((entry): entry is { name: string; position: number } => entry.position !== undefined)
    .sort((left, right) => left.position - right.position || naturalOrder.compare(left.name, right.name))
    .map((entry) => path.join(directory, entry.name))
}

function sampleDirectoryFiles(directory: string, subdirectory: string, stem: string, singleVideoDirectory: boolean): string[] {
  const target = path.join(directory, subdirectory)
  try {
    return fs
      .readdirSync(target)
      .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
      .filter((name) => {
        const prefix = `${stem.toLowerCase()}-`
        const basename = path.parse(name).name.toLowerCase()
        if (subdirectory === NFO_SAMPLE_BACKUP_DIRECTORY) {
          return basename.startsWith(prefix) && /^\d+$/u.test(basename.slice(prefix.length))
        }
        return singleVideoDirectory || basename.startsWith(prefix)
      })
      .sort(naturalOrder.compare)
      .map((name) => path.join(target, name))
  } catch {
    return []
  }
}

function actorFallbacks(directory: string, name: string): string[] {
  const safeName = name.replace(/[\\/:*?"<>|]/gu, '_')
  const underscore = safeName.replace(/\s+/gu, '_')
  return filesByStem(path.join(directory, '.actors'), [safeName, underscore])
}

function collectLocalAssets(input: {
  model: NormalizedNfoArtifact
  actors: NormalizedNfoArtifact['actors']
  anchorPath: string
  root: Readonly<MediaLibraryRoot>
  directoryVideoCodes: DirectoryVideoIdentityInput
  fileStore: NfoFileStore
  selectedFields: ReadonlySet<VideoScrapeField>
}): { assets: MetadataAssetRef[]; warnings: string[] } {
  const directory = path.dirname(input.anchorPath)
  const stem = path.basename(input.anchorPath, path.extname(input.anchorPath))
  const warnings: string[] = []
  const seenPhysical = new Set<string>()
  const assets: MetadataAssetRef[] = []
  const singleVideoDirectory = sameLogicalCode(input.directoryVideoCodes)

  const add = (
    field: Extract<MetadataAssetRef, { kind: 'managed-root-file' }>['field'],
    position: number,
    filePath: string
  ): boolean => {
    try {
      const issued = input.fileStore.issue(input.root, filePath)
      if (seenPhysical.has(issued.physicalKey)) return false
      seenPhysical.add(issued.physicalKey)
      assets.push({
        kind: 'managed-root-file',
        field,
        position,
        capability: issued.capability,
        filename: issued.filename
      })
      return true
    } catch {
      warnings.push('NFO 引用的本地图片无效或越过媒体库根目录，已忽略')
      return false
    }
  }

  if (input.selectedFields.has('cover')) {
    const coverCandidates = [
      ...input.model.coverReferences.map((reference) => referencePath(directory, reference)),
      ...filesByStem(directory, [`${stem}-poster`,
        ...(singleVideoDirectory ? ['poster', 'folder', 'cover'] : [])])
    ]
    for (const candidate of coverCandidates) {
      if (add('cover', 0, candidate)) break
    }
  }

  if (input.selectedFields.has('samples')) {
    const backupFiles = sampleDirectoryFiles(directory, NFO_SAMPLE_BACKUP_DIRECTORY, stem, false)
    const hasReferences = input.model.sampleReferences.length > 0
    // New backups contain only samples. Do not mix their background or legacy copies back in.
    const sampleCandidates = backupFiles.length > 0 ? backupFiles : [
      ...(hasReferences
        ? input.model.sampleReferences.map((reference) => referencePath(directory, reference))
        : filesByStem(directory, [`${stem}-fanart`,
            ...(singleVideoDirectory ? ['fanart', 'backdrop', 'background'] : [])])),
      // Plex/Infuse reference the background but leave exported samples out of XML.
      // Supplement explicit references only with files owned by this exact video stem.
      ...sampleDirectoryFiles(directory, 'extrafanart', stem, singleVideoDirectory && !hasReferences)
    ]
    let position = 0
    for (const candidate of sampleCandidates) {
      if (add('samples', position, candidate)) position += 1
    }
  }

  if (
    input.selectedFields.has('actressesFemale') ||
    input.selectedFields.has('actressesMale')
  ) {
    input.actors.forEach((actor, position) => {
      const candidates = [
        ...actor.thumbReferences.map((reference) => referencePath(directory, reference)),
        ...actorFallbacks(directory, actor.name)
      ]
      for (const candidate of candidates) {
        if (add('actressAvatar', position, candidate)) break
      }
    })
  }

  return { assets, warnings }
}

function hasProjectedContent(result: ScrapeResult, assets: MetadataAssetRef[]): boolean {
  return Object.keys(result).some((key) => key !== 'code') || assets.length > 0
}

export class LocalNfoSourceAdapter implements VideoMetadataSource {
  readonly descriptor: VideoMetadataSourceDescriptor = {
    id: LOCAL_NFO_SOURCE_ID,
    name: LOCAL_NFO_SOURCE_NAME,
    kind: 'local-nfo',
    origin: 'host',
    version: '1.0.0',
    supportedFields: [...LOCAL_NFO_SUPPORTED_FIELDS]
  }

  constructor(private readonly options: LocalNfoSourceAdapterOptions) {}

  async collect(request: VideoMetadataSourceRequest): Promise<MetadataCandidateBatch> {
    if (request.target.kind !== 'video') return { candidates: [], warnings: [] }
    return this.collectFromAnchors(
      request,
      await this.options.listAnchors(request.target.videoId)
    )
  }

  inspectIdentity(anchor: LocalNfoAnchor): LocalNfoIdentityInspection {
    const located = locateNfoSidecar({
      anchorPath: anchor.anchorPath,
      root: anchor.root,
      directoryVideoCodes: anchor.directoryVideoCodes,
      directorySidecars: anchor.directorySidecars,
      fileStore: this.options.fileStore
    })
    const warnings = located.warnings.map((warning) => warning.message)
    if (located.status === 'missing') return { status: 'missing', code: null, warnings: [] }
    if (located.status !== 'found' || !located.capability) {
      return { status: 'warning', code: null, warnings }
    }
    try {
      const parsed = parseNfoArtifact(this.options.fileStore.readBytes(located.capability))
      return {
        status: 'found',
        code: parsed.model.code,
        warnings: [...warnings, ...parsed.warnings.map((warning) => warning.message)]
      }
    } catch (error) {
      return {
        status: 'warning',
        code: null,
        warnings: [
          ...warnings,
          error instanceof Error ? error.message : 'NFO 文件无法读取'
        ]
      }
    }
  }

  async collectFromAnchors(
    request: VideoMetadataSourceRequest,
    anchors: readonly LocalNfoAnchor[]
  ): Promise<MetadataCandidateBatch> {
    if (request.target.kind !== 'video') return { candidates: [], warnings: [] }
    const targetCode = normalizeVideoCode(request.target.code)
    const selectedFields = new Set(
      request.fields.filter((field) =>
        (LOCAL_NFO_SUPPORTED_FIELDS as readonly VideoScrapeField[]).includes(field)
      )
    )
    const warnings: string[] = []
    const candidates: VideoMetadataCandidate[] = []
    const seenPhysicalNfo = new Set<string>()
    const directorySidecarsByScope = new NfoDirectoryCache<ReadonlyMap<string, string>>()

    for (const anchor of anchors) {
      let directorySidecars = anchor.directorySidecars
      if (directorySidecars === undefined) {
        const key = directoryScopeKey(anchor.root, anchor.anchorPath)
        directorySidecars = directorySidecarsByScope.get(key)
        if (directorySidecars === undefined) {
          try {
            directorySidecars = indexNfoSidecars(fs.readdirSync(path.dirname(anchor.anchorPath)))
            directorySidecarsByScope.admit(key, directorySidecars, directorySidecars)
          } catch {
            // Avoid a second read by the locator for this anchor, but retry the next.
            directorySidecars = new Map()
          }
        }
      }
      const located = locateNfoSidecar({
        anchorPath: anchor.anchorPath,
        root: anchor.root,
        directoryVideoCodes: anchor.directoryVideoCodes,
        directorySidecars,
        fileStore: this.options.fileStore
      })
      warnings.push(...located.warnings.map((warning) => warning.message))
      if (located.status !== 'found' || !located.capability || !located.physicalKey) continue
      if (seenPhysicalNfo.has(located.physicalKey)) continue
      seenPhysicalNfo.add(located.physicalKey)

      let parsed: ReturnType<typeof parseNfoArtifact>
      try {
        parsed = parseNfoArtifact(this.options.fileStore.readBytes(located.capability))
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : 'NFO 文件无法读取')
        continue
      }
      warnings.push(...parsed.warnings.map((warning) => warning.message))
      const candidateCode = parsed.model.code ?? targetCode
      if (candidateCode !== targetCode) {
        warnings.push('NFO 番号与目标影片不一致，已跳过')
        continue
      }
      const resolvedActors = parsed.model.actors.map((actor) => {
        const existingGender = this.options.findExistingActorGender(actor.name)
        const gender = actor.declaredGender ?? existingGender ?? 'female'
        if (!actor.declaredGender && !existingGender && parsed.model.dialect === 'unknown') {
          warnings.push(`未知 NFO 方言中的演员「${actor.name}」按女优导入`)
        }
        return { actor, actress: { name: actor.name, gender } }
      })
      const actresses = resolvedActors.map(({ actress }) => actress)
      const raw: ScrapeResult = {
        code: candidateCode,
        ...(parsed.model.title ? { title: parsed.model.title } : {}),
        ...(parsed.model.summary ? { summary: parsed.model.summary } : {}),
        ...(parsed.model.releaseDate ? { releaseDate: parsed.model.releaseDate } : {}),
        ...(parsed.model.maker ? { maker: parsed.model.maker } : {}),
        ...(parsed.model.publisher ? { publisher: parsed.model.publisher } : {}),
        ...(parsed.model.series ? { series: parsed.model.series } : {}),
        ...(parsed.model.director ? { director: parsed.model.director } : {}),
        ...(parsed.model.durationSeconds ? { durationSeconds: parsed.model.durationSeconds } : {}),
        ...(parsed.model.ratingAverage !== undefined
          ? { ratingAverage: parsed.model.ratingAverage }
          : {}),
        ...(parsed.model.ratingCount !== undefined
          ? { ratingCount: parsed.model.ratingCount }
          : {}),
        ...(parsed.model.tags.length > 0 ? { tags: parsed.model.tags } : {}),
        ...(actresses.length > 0 ? { actresses } : {})
      }
      const result = projectVideoScrapeResult(raw, selectedFields, targetCode)
      const projectedActors = resolvedActors
        .filter(({ actress }) =>
          actress.gender === 'female'
            ? selectedFields.has('actressesFemale')
            : selectedFields.has('actressesMale')
        )
        .map(({ actor }) => actor)
      const localAssets = collectLocalAssets({
        model: parsed.model,
        actors: projectedActors,
        anchorPath: anchor.anchorPath,
        root: anchor.root,
        directoryVideoCodes: anchor.directoryVideoCodes,
        fileStore: this.options.fileStore,
        selectedFields
      })
      warnings.push(...localAssets.warnings)
      if (!hasProjectedContent(result, localAssets.assets)) continue
      candidates.push({
        result,
        assets: localAssets.assets,
        evidence: {
          kind: 'local-nfo',
          sourceId: LOCAL_NFO_SOURCE_ID,
          sourceName: LOCAL_NFO_SOURCE_NAME
        }
      })
    }
    return { candidates, warnings }
  }
}
