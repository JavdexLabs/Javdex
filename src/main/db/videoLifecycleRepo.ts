import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  DeleteVideoGloballyInput,
  MoveVideoResourceInput,
  RemoveVideoFromLibraryInput,
  VideoLifecycleImpact,
  VideoLifecycleKind,
  VideoLifecycleLibraryImpact,
  VideoLifecycleMediaAssetImpact,
  VideoLifecyclePlaylistImpact,
  VideoLifecycleResourceImpact,
  VideoLifecycleResult
} from '@shared/videoLifecycleTypes'
import type { VideoResource } from '@shared/videoTypes'
import { maskVideoResourceLocator } from '@shared/videoResourceLinks'
import { discoveryKeyForMembership } from './libraryMembershipRepo'
import { selectLibraryVideoResourcePromotionCandidate } from './videoResourcePromotionRepo'

interface MembershipRow {
  library_id: number
  library_name: string
  library_status: 'active' | 'archived'
  library_revision: number
  added_at: string
  updated_at: string
  added_via: 'scan' | 'manual' | 'shared'
  is_pinned: number
  is_hidden: number
  discovery_key: number
}

interface PlaylistRow {
  playlist_id: number
  name: string
  position: number
  added_at: string
}

interface MediaAssetRow {
  id: number
  type: string
  position: number
  remote_url: string | null
  local_path: string | null
  width: number | null
  height: number | null
  is_primary: number
  created_at: string | null
}

interface PendingScrapeRow {
  id: number
  revision: number
  updated_at: string
}

interface PendingStagingRow {
  owner_id: string
  resource_id: number
  field: string
  position: number
  staged_path: string
}

interface AgentDraftRow {
  id: string
  revision: number
  status: string
  updated_at: string
}

interface VideoDeleteRow {
  id: number
  cover_path: string | null
  poster_path: string | null
  updated_at: string | null
}

interface GlobalDeleteSnapshot {
  video: VideoDeleteRow
  memberships: MembershipRow[]
  resources: VideoResource[]
  playlists: PlaylistRow[]
  mediaAssets: MediaAssetRow[]
  pendingScrapes: PendingScrapeRow[]
  pendingScrapeStaging: PendingStagingRow[]
  agentDrafts: AgentDraftRow[]
  agentDraftStaging: PendingStagingRow[]
}

interface StoredOperationRow {
  input_hash: string
  result_json: string
}

function requireId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} 必须是正整数`)
  return value
}

function requireOperationId(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 200) throw new Error('操作 ID 无效')
  return normalized
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function listMemberships(database: Database.Database, videoId: number): MembershipRow[] {
  return database
    .prepare(
      `SELECT membership.library_id,
              library.name AS library_name,
              library.status AS library_status,
              library.revision AS library_revision,
              membership.added_at,
              membership.updated_at,
              membership.added_via,
              membership.is_pinned,
              membership.is_hidden,
              membership.discovery_key
       FROM library_video_memberships membership
       JOIN media_libraries library ON library.id = membership.library_id
       WHERE membership.video_id = ?
       ORDER BY membership.library_id`
    )
    .all(videoId) as MembershipRow[]
}

function listResources(database: Database.Database, videoId: number): VideoResource[] {
  return database
    .prepare('SELECT * FROM video_resources WHERE video_id = ? ORDER BY library_id, id')
    .all(videoId) as VideoResource[]
}

function sourcePaths(resources: VideoResource[]): string[] {
  return Array.from(
    new Set(
      resources.flatMap((resource) => {
        if (resource.kind === 'local') return [resource.locator]
        return resource.strm_source_path ? [resource.strm_source_path] : []
      })
    )
  )
}

function relationCounts(
  database: Database.Database,
  videoId: number
): { playlistCount: number; assetCount: number } {
  const playlistCount = (
    database.prepare('SELECT COUNT(*) AS count FROM playlist_video WHERE video_id = ?').get(
      videoId
    ) as { count: number }
  ).count
  const assetCount = (
    database.prepare('SELECT COUNT(*) AS count FROM video_assets WHERE video_id = ?').get(
      videoId
    ) as { count: number }
  ).count
  return { playlistCount, assetCount }
}

function sourceFilePath(resource: VideoResource): string | null {
  if (resource.kind === 'local') return resource.locator
  return resource.strm_source_path
}

function projectResources(resources: VideoResource[]): VideoLifecycleResourceImpact[] {
  return resources.map((resource) => ({
    resourceId: resource.id,
    libraryId: resource.library_id,
    kind: resource.kind,
    displayName: resource.display_name,
    displayLocator:
      resource.kind === 'local'
        ? resource.locator
        : maskVideoResourceLocator(resource.locator, resource.kind),
    isPrimary: resource.is_primary === 1,
    sourceFilePath: sourceFilePath(resource)
  }))
}

function projectLibraries(
  memberships: MembershipRow[],
  resources: VideoResource[]
): VideoLifecycleLibraryImpact[] {
  const resourceCounts = new Map<number, number>()
  for (const resource of resources) {
    resourceCounts.set(resource.library_id, (resourceCounts.get(resource.library_id) ?? 0) + 1)
  }
  return memberships.map((membership) => ({
    libraryId: membership.library_id,
    name: membership.library_name,
    status: membership.library_status,
    resourceCount: resourceCounts.get(membership.library_id) ?? 0
  }))
}

function assertWritableMembership(membership: MembershipRow): void {
  if (membership.library_status !== 'active') {
    throw new Error('已归档媒体库必须恢复后才能修改')
  }
}

function baseImpactDetails(input: {
  memberships: MembershipRow[]
  resources: VideoResource[]
}): Pick<
  VideoLifecycleImpact,
  | 'libraries'
  | 'resources'
  | 'playlists'
  | 'mediaAssets'
  | 'pendingScrapeCount'
  | 'pendingAgentDraftCount'
  | 'pendingStagingAssetCount'
  | 'sourceFilesPreserved'
> {
  return {
    libraries: projectLibraries(input.memberships, input.resources),
    resources: projectResources(input.resources),
    playlists: [],
    mediaAssets: [],
    pendingScrapeCount: 0,
    pendingAgentDraftCount: 0,
    pendingStagingAssetCount: 0,
    sourceFilesPreserved: true
  }
}

function assertVideo(database: Database.Database, videoId: number): void {
  if (!database.prepare('SELECT 1 FROM videos WHERE id = ?').get(videoId)) {
    throw new Error('影片不存在')
  }
}

function buildRevision(input: {
  kind: VideoLifecycleKind
  videoId: number
  sourceLibraryId: number | null
  targetLibraryId: number | null
  memberships: MembershipRow[]
  resources: VideoResource[]
}): string {
  return stableHash({
    kind: input.kind,
    videoId: input.videoId,
    sourceLibraryId: input.sourceLibraryId,
    targetLibraryId: input.targetLibraryId,
    memberships: input.memberships.map((row) => [
      row.library_id,
      row.library_name,
      row.library_status,
      row.library_revision,
      row.added_at,
      row.updated_at,
      row.added_via,
      row.is_pinned,
      row.is_hidden,
      row.discovery_key
    ]),
    resources: input.resources.map((resource) => [
      resource.id,
      resource.library_id,
      resource.video_id,
      resource.root_id,
      resource.kind,
      resource.locator,
      resource.resource_key,
      resource.source_identity,
      resource.strm_source_path,
      resource.size_bytes,
      resource.duration_seconds,
      resource.file_mtime_ms,
      resource.display_name,
      resource.is_primary,
      resource.add_time
    ])
  })
}

function readGlobalDeleteSnapshot(
  database: Database.Database,
  videoId: number
): GlobalDeleteSnapshot {
  const video = database
    .prepare('SELECT id, cover_path, poster_path, updated_at FROM videos WHERE id = ?')
    .get(videoId) as VideoDeleteRow | undefined
  if (!video) throw new Error('影片不存在')

  const playlists = database
    .prepare(
      `SELECT playlist.id AS playlist_id, playlist.name, relation.position, relation.added_at
       FROM playlist_video relation
       JOIN playlists playlist ON playlist.id = relation.playlist_id
       WHERE relation.video_id = ?
       ORDER BY playlist.id`
    )
    .all(videoId) as PlaylistRow[]
  const mediaAssets = database
    .prepare(
      `SELECT id, type, position, remote_url, local_path, width, height, is_primary, created_at
       FROM video_assets WHERE video_id = ? ORDER BY id`
    )
    .all(videoId) as MediaAssetRow[]
  const pendingScrapes = database
    .prepare(
      `SELECT id, revision, updated_at
       FROM pending_video_scrapes WHERE video_id = ? ORDER BY id`
    )
    .all(videoId) as PendingScrapeRow[]
  const pendingScrapeStaging = database
    .prepare(
      `SELECT CAST(pending.id AS TEXT) AS owner_id,
              resource.id AS resource_id,
              resource.field,
              resource.position,
              resource.staged_path
       FROM pending_video_scrapes pending
       JOIN pending_video_scrape_sources source ON source.pending_scrape_id = pending.id
       JOIN pending_video_scrape_candidates candidate ON candidate.source_id = source.id
       JOIN pending_video_scrape_resources resource ON resource.candidate_id = candidate.id
       WHERE pending.video_id = ?
       ORDER BY pending.id, resource.id`
    )
    .all(videoId) as PendingStagingRow[]
  const agentDrafts = database
    .prepare(
      `SELECT id, revision, status, updated_at
       FROM agent_metadata_drafts
       WHERE entity_kind = 'video' AND entity_id = ?
       ORDER BY id`
    )
    .all(videoId) as AgentDraftRow[]
  const agentDraftStaging = database
    .prepare(
      `SELECT draft.id AS owner_id,
              resource.id AS resource_id,
              resource.field,
              resource.position,
              resource.staged_path
       FROM agent_metadata_drafts draft
       JOIN agent_metadata_draft_resources resource ON resource.draft_id = draft.id
       WHERE draft.entity_kind = 'video' AND draft.entity_id = ?
       ORDER BY draft.id, resource.id`
    )
    .all(videoId) as PendingStagingRow[]

  return {
    video,
    memberships: listMemberships(database, videoId),
    resources: listResources(database, videoId),
    playlists,
    mediaAssets,
    pendingScrapes,
    pendingScrapeStaging,
    agentDrafts,
    agentDraftStaging
  }
}

function projectPlaylists(rows: PlaylistRow[]): VideoLifecyclePlaylistImpact[] {
  return rows.map((row) => ({ playlistId: row.playlist_id, name: row.name }))
}

function projectMediaAssets(snapshot: GlobalDeleteSnapshot): VideoLifecycleMediaAssetImpact[] {
  const projected: VideoLifecycleMediaAssetImpact[] = snapshot.mediaAssets.map((asset) => ({
    assetId: asset.id,
    type: asset.type,
    localPath: asset.local_path
  }))
  if (snapshot.video.cover_path) {
    projected.unshift({ assetId: null, type: 'cover', localPath: snapshot.video.cover_path })
  }
  if (
    snapshot.video.poster_path &&
    !projected.some((asset) => asset.localPath === snapshot.video.poster_path)
  ) {
    projected.push({ assetId: null, type: 'poster', localPath: snapshot.video.poster_path })
  }
  return projected
}

function globalDeleteRevision(snapshot: GlobalDeleteSnapshot): string {
  return stableHash({ kind: 'delete-globally', snapshot })
}

function buildGlobalDeleteImpact(snapshot: GlobalDeleteSnapshot): VideoLifecycleImpact {
  const mediaAssets = projectMediaAssets(snapshot)
  const staging = [...snapshot.pendingScrapeStaging, ...snapshot.agentDraftStaging]
  return {
    kind: 'delete-globally',
    revision: globalDeleteRevision(snapshot),
    videoId: snapshot.video.id,
    sourceLibraryId: null,
    targetLibraryId: null,
    resourceIds: snapshot.resources.map((resource) => resource.id),
    sourcePaths: sourcePaths(snapshot.resources),
    remainingLibraryIds: [],
    removesCanonicalVideo: true,
    playlistCount: snapshot.playlists.length,
    assetCount: mediaAssets.length,
    libraries: projectLibraries(snapshot.memberships, snapshot.resources),
    resources: projectResources(snapshot.resources),
    playlists: projectPlaylists(snapshot.playlists),
    mediaAssets,
    pendingScrapeCount: snapshot.pendingScrapes.length,
    pendingAgentDraftCount: snapshot.agentDrafts.length,
    pendingStagingAssetCount: staging.length,
    sourceFilesPreserved: true
  }
}

function obsoleteAssetPaths(snapshot: GlobalDeleteSnapshot): string[] {
  return Array.from(
    new Set(
      [
        snapshot.video.cover_path,
        snapshot.video.poster_path,
        ...snapshot.mediaAssets.map((asset) => asset.local_path)
      ].filter((value): value is string => Boolean(value))
    )
  )
}

function pendingStagingPaths(snapshot: GlobalDeleteSnapshot): string[] {
  return Array.from(
    new Set(
      [...snapshot.pendingScrapeStaging, ...snapshot.agentDraftStaging].map(
        (resource) => resource.staged_path
      )
    )
  )
}

function operationInputHash(kind: VideoLifecycleKind, input: object): string {
  return stableHash({ kind, input })
}

function replayOrThrow<Result extends VideoLifecycleResult = VideoLifecycleResult>(
  database: Database.Database,
  operationId: string,
  inputHash: string
): Result | null {
  const row = database
    .prepare('SELECT input_hash, result_json FROM video_lifecycle_operations WHERE id = ?')
    .get(operationId) as StoredOperationRow | undefined
  if (!row) return null
  if (row.input_hash !== inputHash) throw new Error('操作 ID 已用于不同的生命周期命令')
  return JSON.parse(row.result_json) as Result
}

function recordResult(
  database: Database.Database,
  operationId: string,
  kind: VideoLifecycleKind,
  inputHash: string,
  result: VideoLifecycleResult
): void {
  database
    .prepare(
      `INSERT INTO video_lifecycle_operations (id, kind, input_hash, result_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(operationId, kind, inputHash, JSON.stringify(result), new Date().toISOString())
}

export interface VideoLifecycleRepo {
  previewRemoveFromLibrary(libraryId: number, videoId: number): VideoLifecycleImpact
  removeFromLibrary(input: RemoveVideoFromLibraryInput): VideoLifecycleResult
  previewMoveResource(
    sourceLibraryId: number,
    targetLibraryId: number,
    resourceId: number
  ): VideoLifecycleImpact
  moveResource(input: MoveVideoResourceInput): VideoLifecycleResult
  previewDeleteGlobally(videoId: number): VideoLifecycleImpact
  deleteGlobally(input: DeleteVideoGloballyInput): DeleteVideoGloballyRepoResult
}

/** Internal cleanup obligations are persisted with the idempotent operation result. */
export interface DeleteVideoGloballyRepoResult extends VideoLifecycleResult {
  obsoleteAssetPaths: string[]
  pendingStagingPaths: string[]
}

export function createVideoLifecycleRepo(
  database: Database.Database,
  dependencies: { isLocalAccessible: (path: string) => boolean }
): VideoLifecycleRepo {
  const { isLocalAccessible } = dependencies
  const previewRemoveFromLibrary = (
    libraryIdRaw: number,
    videoIdRaw: number
  ): VideoLifecycleImpact => {
    const libraryId = requireId(libraryIdRaw, '媒体库 ID')
    const videoId = requireId(videoIdRaw, '影片 ID')
    assertVideo(database, videoId)
    const memberships = listMemberships(database, videoId)
    const sourceMembership = memberships.find((row) => row.library_id === libraryId)
    if (!sourceMembership) {
      throw new Error('影片不属于当前媒体库')
    }
    assertWritableMembership(sourceMembership)
    const resources = listResources(database, videoId)
    const affected = resources.filter((resource) => resource.library_id === libraryId)
    const affectedMemberships = memberships.filter((row) => row.library_id === libraryId)
    const remainingLibraryIds = memberships
      .map((row) => row.library_id)
      .filter((id) => id !== libraryId)
    const counts = relationCounts(database, videoId)
    return {
      kind: 'remove-from-library',
      revision: buildRevision({
        kind: 'remove-from-library',
        videoId,
        sourceLibraryId: libraryId,
        targetLibraryId: null,
        memberships,
        resources
      }),
      videoId,
      sourceLibraryId: libraryId,
      targetLibraryId: null,
      resourceIds: affected.map((resource) => resource.id),
      sourcePaths: sourcePaths(affected),
      remainingLibraryIds,
      removesCanonicalVideo: false,
      ...counts,
      ...baseImpactDetails({ memberships: affectedMemberships, resources: affected })
    }
  }

  const previewMoveResource = (
    sourceLibraryIdRaw: number,
    targetLibraryIdRaw: number,
    resourceIdRaw: number
  ): VideoLifecycleImpact => {
    const sourceLibraryId = requireId(sourceLibraryIdRaw, '源媒体库 ID')
    const targetLibraryId = requireId(targetLibraryIdRaw, '目标媒体库 ID')
    const resourceId = requireId(resourceIdRaw, '资源 ID')
    if (sourceLibraryId === targetLibraryId) throw new Error('源媒体库与目标媒体库不能相同')
    const resource = database
      .prepare('SELECT * FROM video_resources WHERE id = ? AND library_id = ?')
      .get(resourceId, sourceLibraryId) as VideoResource | undefined
    if (!resource) throw new Error('资源不属于源媒体库')
    const memberships = listMemberships(database, resource.video_id)
    const sourceMembership = memberships.find((row) => row.library_id === sourceLibraryId)
    if (!sourceMembership) throw new Error('资源所属媒体库成员不存在')
    assertWritableMembership(sourceMembership)
    if (resource.source_identity || resource.strm_source_path) {
      throw new Error('本地与 STRM 资源必须通过根目录迁移，不能单独移动到其它媒体库')
    }
    const target = database
      .prepare("SELECT 1 FROM media_libraries WHERE id = ? AND status = 'active'")
      .get(targetLibraryId)
    if (!target) throw new Error('目标媒体库不存在或已归档')
    const duplicate = database
      .prepare(
        `SELECT 1 FROM video_resources
         WHERE library_id = ? AND resource_key = ? AND id != ?`
      )
      .get(targetLibraryId, resource.resource_key, resourceId)
    if (duplicate) throw new Error('目标媒体库已存在等价资源')
    const resources = listResources(database, resource.video_id)
    const counts = relationCounts(database, resource.video_id)
    return {
      kind: 'move-resource',
      revision: buildRevision({
        kind: 'move-resource',
        videoId: resource.video_id,
        sourceLibraryId,
        targetLibraryId,
        memberships,
        resources
      }),
      videoId: resource.video_id,
      sourceLibraryId,
      targetLibraryId,
      resourceIds: [resource.id],
      sourcePaths: sourcePaths([resource]),
      remainingLibraryIds: Array.from(
        new Set([...memberships.map((row) => row.library_id), targetLibraryId])
      ).sort((left, right) => left - right),
      removesCanonicalVideo: false,
      ...counts,
      ...baseImpactDetails({
        memberships: memberships.filter(
          (row) => row.library_id === sourceLibraryId || row.library_id === targetLibraryId
        ),
        resources: [resource]
      })
    }
  }

  const previewDeleteGlobally = (videoIdRaw: number): VideoLifecycleImpact => {
    const videoId = requireId(videoIdRaw, '影片 ID')
    return buildGlobalDeleteImpact(readGlobalDeleteSnapshot(database, videoId))
  }

  return {
    previewRemoveFromLibrary,
    removeFromLibrary(input): VideoLifecycleResult {
      const operationId = requireOperationId(input.operationId)
      const inputHash = operationInputHash('remove-from-library', {
        libraryId: input.libraryId,
        videoId: input.videoId,
        expectedRevision: input.expectedRevision
      })
      return database.transaction(() => {
        const replay = replayOrThrow(database, operationId, inputHash)
        if (replay) return replay
        const preview = previewRemoveFromLibrary(input.libraryId, input.videoId)
        if (preview.revision !== input.expectedRevision) throw new Error('生命周期预览已过期')
        database
          .prepare(
            'DELETE FROM library_video_memberships WHERE library_id = ? AND video_id = ?'
          )
          .run(input.libraryId, input.videoId)
        const result: VideoLifecycleResult = {
          operationId,
          kind: 'remove-from-library',
          videoId: input.videoId,
          sourceLibraryId: input.libraryId,
          targetLibraryId: null,
          resourceIds: preview.resourceIds,
          promotedResourceId: null,
          canonicalVideoDeleted: false
        }
        recordResult(database, operationId, result.kind, inputHash, result)
        return result
      }).immediate()
    },
    previewMoveResource,
    moveResource(input): VideoLifecycleResult {
      const operationId = requireOperationId(input.operationId)
      const inputHash = operationInputHash('move-resource', {
        sourceLibraryId: input.sourceLibraryId,
        targetLibraryId: input.targetLibraryId,
        resourceId: input.resourceId,
        expectedRevision: input.expectedRevision
      })
      return database.transaction(() => {
        const replay = replayOrThrow(database, operationId, inputHash)
        if (replay) return replay
        const preview = previewMoveResource(
          input.sourceLibraryId,
          input.targetLibraryId,
          input.resourceId
        )
        if (preview.revision !== input.expectedRevision) throw new Error('生命周期预览已过期')
        const resource = database
          .prepare('SELECT * FROM video_resources WHERE id = ? AND library_id = ?')
          .get(input.resourceId, input.sourceLibraryId) as VideoResource
        database
          .prepare(
            `INSERT OR IGNORE INTO library_video_memberships (
               library_id, video_id, added_at, updated_at, added_via, discovery_key
             ) VALUES (?, ?, ?, ?, 'shared', ?)`
          )
          .run(
            input.targetLibraryId,
            resource.video_id,
            resource.add_time,
            resource.add_time,
            discoveryKeyForMembership(input.targetLibraryId, resource.video_id)
          )
        const targetHasPrimary = database
          .prepare(
            `SELECT 1 FROM video_resources
             WHERE library_id = ? AND video_id = ? AND is_primary = 1`
          )
          .get(input.targetLibraryId, resource.video_id)
        database
          .prepare(
            `UPDATE video_resources
             SET library_id = ?, root_id = NULL, is_primary = ?
             WHERE id = ? AND library_id = ?`
          )
          .run(
            input.targetLibraryId,
            targetHasPrimary ? 0 : 1,
            input.resourceId,
            input.sourceLibraryId
          )
        let promotedResourceId: number | null = null
        if (resource.is_primary) {
          const candidate = selectLibraryVideoResourcePromotionCandidate(database, {
            libraryId: input.sourceLibraryId,
            videoId: resource.video_id,
            isLocalAccessible
          })
          if (candidate) {
            database
              .prepare('UPDATE video_resources SET is_primary = 1 WHERE id = ?')
              .run(candidate.id)
            promotedResourceId = candidate.id
          }
        }
        const result: VideoLifecycleResult = {
          operationId,
          kind: 'move-resource',
          videoId: resource.video_id,
          sourceLibraryId: input.sourceLibraryId,
          targetLibraryId: input.targetLibraryId,
          resourceIds: [input.resourceId],
          promotedResourceId,
          canonicalVideoDeleted: false
        }
        recordResult(database, operationId, result.kind, inputHash, result)
        return result
      }).immediate()
    },
    previewDeleteGlobally,
    deleteGlobally(input): DeleteVideoGloballyRepoResult {
      const operationId = requireOperationId(input.operationId)
      const inputHash = operationInputHash('delete-globally', {
        videoId: input.videoId,
        expectedRevision: input.expectedRevision
      })
      return database.transaction(() => {
        const replay = replayOrThrow<DeleteVideoGloballyRepoResult>(
          database,
          operationId,
          inputHash
        )
        if (replay) return replay
        const videoId = requireId(input.videoId, '影片 ID')
        const snapshot = readGlobalDeleteSnapshot(database, videoId)
        const preview = buildGlobalDeleteImpact(snapshot)
        if (preview.revision !== input.expectedRevision) throw new Error('生命周期预览已过期')
        database
          .prepare("DELETE FROM agent_metadata_drafts WHERE entity_kind = 'video' AND entity_id = ?")
          .run(videoId)
        const deleted = database.prepare('DELETE FROM videos WHERE id = ?').run(videoId)
        if (deleted.changes !== 1) throw new Error('影片不存在')
        const result: DeleteVideoGloballyRepoResult = {
          operationId,
          kind: 'delete-globally',
          videoId,
          sourceLibraryId: null,
          targetLibraryId: null,
          resourceIds: preview.resourceIds,
          promotedResourceId: null,
          canonicalVideoDeleted: true,
          obsoleteAssetPaths: obsoleteAssetPaths(snapshot),
          pendingStagingPaths: pendingStagingPaths(snapshot)
        }
        recordResult(database, operationId, result.kind, inputHash, result)
        return result
      }).immediate()
    }
  }
}
