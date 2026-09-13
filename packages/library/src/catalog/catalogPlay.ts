import type Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import type { VideoResource } from '@shared/videoTypes'
import type { PlayGrant, PlayGrantInput } from '@shared/protocol/play'
import { PLAY_GRANT_TTL_MS } from '@shared/protocol/limits'
import { structuredError } from '@shared/protocol/errors'
import { getDb } from '@library/db/database'
import { getMediaLibrary } from '@library/db/mediaLibraryRepo'
import { getVideoById, getVideoResourceInLibrary } from '@library/db/videoRepo'
import { createAuthorizedMediaLibraryRootFileInspector } from '@library/scan/mediaLibraryRootFileGuard'
import { digestEquals, digestToken, generateSecret, sha256Hex } from './catalogSecrets'
import { readCatalogIdentity } from './catalogIdentity'
import { readCatalogSetting, writeCatalogSetting } from './catalogSettings'

const GRANT_KEY_PREFIX = 'play-grant:'
const TOKEN_KEY_PREFIX = 'play-token:'
const VIDEO_MIMES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska'
}

export interface StoredPlayGrant {
  grantId: string
  tokenDigest: string
  libraryId: number
  videoId: number
  resourceId: number
  locatorRevision: string
  writerEpoch: number
  expiresAt: string
  createdAt: string
}

export interface InspectedPlayStream {
  grant: StoredPlayGrant
  file: string
  mime: string
  stat: { dev: number; ino: number; size: number; mtimeMs: number }
}

export interface PlayGrantListener {
  onRevoke(grantIds: string[]): void
}

let playGrantListener: PlayGrantListener | null = null

export function setPlayGrantListener(listener: PlayGrantListener | null): void {
  playGrantListener = listener
}

export function notifyPlayGrantsRevoked(grantIds: string[]): void {
  if (grantIds.length === 0) return
  playGrantListener?.onRevoke(grantIds)
}

export function resourceLocatorRevision(resource: Pick<
  VideoResource,
  'kind' | 'locator' | 'source_identity' | 'root_id' | 'size_bytes' | 'file_mtime_ms'
>): string {
  return sha256Hex(
    JSON.stringify({
      kind: resource.kind,
      locator: resource.locator,
      sourceIdentity: resource.source_identity,
      rootId: resource.root_id,
      sizeBytes: resource.size_bytes,
      fileMtimeMs: resource.file_mtime_ms
    })
  )
}

function grantKey(grantId: string): string {
  return `${GRANT_KEY_PREFIX}${grantId}`
}

function tokenKey(tokenDigest: string): string {
  return `${TOKEN_KEY_PREFIX}${tokenDigest}`
}

function deleteGrantKeys(
  grant: Pick<StoredPlayGrant, 'grantId' | 'tokenDigest'>,
  database: Database.Database
): void {
  database.prepare('DELETE FROM catalog_settings WHERE key = ?').run(grantKey(grant.grantId))
  database.prepare('DELETE FROM catalog_settings WHERE key = ?').run(tokenKey(grant.tokenDigest))
}

function readGrant(grantId: string, database: Database.Database): StoredPlayGrant | null {
  return readCatalogSetting<StoredPlayGrant | null>(grantKey(grantId), null, database)
}

export function listStoredPlayGrantIds(database: Database.Database = getDb()): string[] {
  const rows = database
    .prepare("SELECT key FROM catalog_settings WHERE key LIKE 'play-grant:%'")
    .all() as Array<{ key: string }>
  return rows.map((row) => row.key.slice(GRANT_KEY_PREFIX.length))
}

export function revokeAllPlayGrants(database: Database.Database = getDb()): string[] {
  const ids = listStoredPlayGrantIds(database)
  database
    .prepare(
      "DELETE FROM catalog_settings WHERE key LIKE 'play-grant:%' OR key LIKE 'play-token:%'"
    )
    .run()
  return ids
}

export function grantCatalogPlayback(
  input: PlayGrantInput,
  options: { now?: Date; ttlMs?: number; publicOrigin?: string } = {},
  database: Database.Database = getDb()
): PlayGrant {
  const identity = readCatalogIdentity(database)
  if (!identity?.serverId) {
    throw structuredError('AUTH_REQUIRED', '实例尚未认主')
  }
  if (identity.frozen) throw structuredError('CATALOG_FROZEN', '资料库已冻结')
  const library = getMediaLibrary(input.libraryId)
  if (!library) throw structuredError('INVALID_INPUT', '媒体库不存在', { field: 'libraryId' })
  if (library.status !== 'active') {
    throw structuredError('INVALID_INPUT', '已归档媒体库必须恢复后才能播放', { field: 'libraryId' })
  }
  if (!getVideoById(input.videoId, database)) {
    throw structuredError('INVALID_INPUT', '视频记录不存在', { field: 'videoId' })
  }
  const resource = getVideoResourceInLibrary(input.libraryId, input.resourceId)
  if (!resource || resource.video_id !== input.videoId) {
    throw structuredError('INVALID_INPUT', '资源记录不存在', { field: 'resourceId' })
  }
  if (resource.kind !== 'local' || resource.root_id == null) {
    throw structuredError(
      'INVALID_INPUT',
      '仅本地影片资源可签发播放凭据；外链请在桌面直接打开',
      { field: 'resourceId' }
    )
  }
  const locatorRevision = resourceLocatorRevision(resource)
  if (locatorRevision !== input.locatorRevision) {
    throw structuredError('VERSION_CONFLICT', '资源定位已变化，请刷新后重新播放', {
      field: 'locatorRevision'
    })
  }
  inspectLocalResourceFile(resource)
  const now = options.now ?? new Date()
  const ttlMs = options.ttlMs ?? PLAY_GRANT_TTL_MS
  const grantId = cryptoRandomUuid()
  const token = generateSecret()
  const stored: StoredPlayGrant = {
    grantId,
    tokenDigest: digestToken(token),
    libraryId: input.libraryId,
    videoId: input.videoId,
    resourceId: input.resourceId,
    locatorRevision,
    writerEpoch: identity.writerEpoch,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    createdAt: now.toISOString()
  }
  writeCatalogSetting(grantKey(grantId), stored, database)
  writeCatalogSetting(tokenKey(stored.tokenDigest), grantId, database)
  const pathAndQuery = `/play/v1/${grantId}?t=${encodeURIComponent(token)}`
  const origin = options.publicOrigin?.replace(/\/+$/, '') ?? ''
  return {
    grantId,
    resourceId: resource.id,
    expiresAt: stored.expiresAt,
    playbackHandle: origin ? `${origin}${pathAndQuery}` : pathAndQuery,
    methods: ['HEAD', 'GET'],
    range: true
  }
}

function cryptoRandomUuid(): string {
  return globalThis.crypto.randomUUID()
}

function inspectLocalResourceFile(resource: VideoResource): {
  file: string
  mime: string
  stat: fs.Stats
} {
  if (resource.kind !== 'local' || resource.root_id == null) {
    throw structuredError('INVALID_INPUT', '此资源不支持原文件播放')
  }
  const mime = VIDEO_MIMES[path.extname(resource.locator).toLowerCase()]
  if (!mime) throw structuredError('INVALID_INPUT', '此文件格式不支持原文件播放')
  try {
    const checked = createAuthorizedMediaLibraryRootFileInspector()(
      resource.library_id,
      resource.root_id,
      resource.locator
    )
    return { file: checked.fileRealPath, mime, stat: checked.stat }
  } catch {
    throw structuredError('INVALID_INPUT', '资源文件不可用或不在已授权根目录内')
  }
}

export function inspectPlayStream(
  input: { grantId: string; token: string; now?: Date },
  database: Database.Database = getDb()
): InspectedPlayStream {
  const grant = readGrant(input.grantId, database)
  if (!grant || !digestEquals(grant.tokenDigest, digestToken(input.token))) {
    throw structuredError('AUTH_REQUIRED', '播放凭据无效或已过期')
  }
  const now = input.now ?? new Date()
  if (Date.parse(grant.expiresAt) <= now.getTime()) {
    deleteGrantKeys(grant, database)
    notifyPlayGrantsRevoked([grant.grantId])
    throw structuredError('AUTH_REQUIRED', '播放凭据无效或已过期')
  }
  const identity = readCatalogIdentity(database)
  if (!identity || identity.frozen || identity.writerEpoch !== grant.writerEpoch) {
    deleteGrantKeys(grant, database)
    notifyPlayGrantsRevoked([grant.grantId])
    throw structuredError('AUTH_REQUIRED', '播放凭据无效或已过期')
  }
  const library = getMediaLibrary(grant.libraryId)
  const resource = getVideoResourceInLibrary(grant.libraryId, grant.resourceId)
  if (
    !library ||
    library.status !== 'active' ||
    !resource ||
    resource.video_id !== grant.videoId ||
    resourceLocatorRevision(resource) !== grant.locatorRevision
  ) {
    deleteGrantKeys(grant, database)
    notifyPlayGrantsRevoked([grant.grantId])
    throw structuredError('AUTH_REQUIRED', '播放凭据无效或已过期')
  }
  const opened = inspectLocalResourceFile(resource)
  return {
    grant,
    file: opened.file,
    mime: opened.mime,
    stat: {
      dev: opened.stat.dev,
      ino: opened.stat.ino,
      size: opened.stat.size,
      mtimeMs: opened.stat.mtimeMs
    }
  }
}
