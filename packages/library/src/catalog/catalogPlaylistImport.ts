import type Database from 'better-sqlite3'
import type { ManageOperationInput } from '@shared/manage/inputs'
import type { PlaylistApplyImportResult } from '@shared/playlistImportCommit'
import type { ExpectedVersions } from '@shared/protocol/versions'
import { structuredError } from '@shared/protocol/errors'
import { getDb } from '@library/db/database'
import { getVideoById } from '@library/db/videoRepo'
import { getMediaLibraryDetail } from '@library/db/mediaLibraryRepo'
import { writePlaylistImport } from './playlistImportWrite'
import { commitPreparedUpload, prepareUploadApply } from '@library/catalog/catalogImageApply'
import { mediaAssetStore } from '@library/mediaAssetStore'
import {
  readPlaylistAggregateVersion,
  readVideoAggregateVersion
} from '@library/catalog/catalogAggregateVersion'

export function applyPlaylistImport(input: ManageOperationInput<'playlists.applyImport'> & {
  expected: ExpectedVersions
  operationId: string
  expectedLibraryRevision: number
  database?: Database.Database
}): PlaylistApplyImportResult {
  const database = input.database ?? getDb()
  const entries = input.entries ?? (input.videoIds ?? []).map((videoId) => ({
    kind: 'existing' as const,
    videoId,
    links: input.videoLinks?.filter((link) => link.videoId === videoId).map(({ label, url }) => ({ label, url }))
  }))
  if (entries.length === 0) {
    throw structuredError('INVALID_INPUT', '清单导入至少需要一个影片或导入条目', { field: 'entries' }, input.operationId)
  }
  const library = getMediaLibraryDetail(input.libraryId)
  if (!library) {
    throw structuredError('INVALID_INPUT', '媒体库不存在', { entityKind: 'library', entityId: input.libraryId }, input.operationId)
  }
  if (library.status !== 'active') {
    throw structuredError('INVALID_INPUT', '目标媒体库已归档，无法导入清单', { entityKind: 'library', entityId: input.libraryId }, input.operationId)
  }
  if (library.revision !== input.expectedLibraryRevision) {
    throw structuredError(
      'VERSION_CONFLICT',
      '媒体库已更新，请刷新后重新导入',
      { entityKind: 'library', entityId: input.libraryId },
      input.operationId
    )
  }
  if (entries.length > 200) {
    throw structuredError(
      'LIMIT_EXCEEDED',
      '清单导入一次最多 200 个影片 ID；更长有序列表需合同增加 targetListId',
      { field: 'entries', limit: 200, actual: entries.length },
      input.operationId
    )
  }
  const existingEntries = entries.filter((entry): entry is Extract<typeof entry, { kind: 'existing' }> => entry.kind === 'existing')
  const firstExistingId = existingEntries[0]?.videoId
  if (firstExistingId == null && input.expected.V) {
    throw structuredError('VERSION_CONFLICT', '清单导入缺少可校验的影片版本', { field: 'expected.V' }, input.operationId)
  }
  if (firstExistingId != null && input.expected.V) {
    const current = readVideoAggregateVersion(firstExistingId, database)
    if (
      !current ||
      current.generation !== input.expected.V.generation ||
      current.revision !== input.expected.V.revision
    ) {
      throw structuredError(
        'VERSION_CONFLICT',
        '影片资料已更新，请刷新后重新导入',
        { entityKind: 'video', entityId: firstExistingId },
        input.operationId
      )
    }
  }
  for (const entry of existingEntries) {
    if (!getVideoById(entry.videoId, database)) {
      throw structuredError('INVALID_INPUT', '清单影片不存在', { field: 'entries', entityId: entry.videoId }, input.operationId)
    }
  }

  let coverRel: string | null | undefined
  if (input.cover?.kind === 'upload') {
    const prepared = prepareUploadApply(
      input.cover.uploadId,
      'playlistCover',
      (bytes) => mediaAssetStore.importPlaylistCoverFromBuffer(input.name, bytes),
      input.operationId,
      {},
      database
    )
    commitPreparedUpload(prepared, input.operationId, [], database)
    coverRel = prepared.formalRel
  } else if (input.cover?.kind === 'clear') {
    coverRel = null
  } else if (input.cover?.kind === 'asset') {
    throw structuredError('INVALID_INPUT', '不能使用其它对象的资产 ID 作为清单封面', { field: 'cover' }, input.operationId)
  }

  const links = input.sourceUrl
    ? [{ label: new URL(input.sourceUrl).host || '来源', url: input.sourceUrl }]
    : undefined
  const allowedVideoIds = new Set(existingEntries.map((entry) => entry.videoId))
  if (input.videoLinks) {
    for (const link of input.videoLinks) {
      if (!allowedVideoIds.has(link.videoId)) {
        throw structuredError(
          'INVALID_INPUT',
          '清单关联链接必须属于本次导入的影片',
          { field: 'videoLinks', entityId: link.videoId },
          input.operationId
        )
      }
    }
  }
  const normalizedEntries = entries.map((entry) => ({
    ...(entry.kind === 'create'
      ? { kind: 'create' as const, code: entry.code, title: entry.title ?? null, links: entry.links }
      : { kind: 'existing' as const, videoId: entry.videoId, links: entry.links }),
    ...(entry.kind === 'existing' && input.entries && input.videoLinks
      ? {
          links: [
            ...(entry.links ?? []),
            ...input.videoLinks
              .filter((link) => link.videoId === entry.videoId)
              .map(({ label, url }) => ({ label, url }))
          ]
        }
      : {})
  }))
  const written = writePlaylistImport({
    destination: { kind: 'create', name: input.name, coverPath: coverRel },
    libraryId: input.libraryId,
    reusedMembership: 'ensure-target',
    sourceLinks: links,
    entries: normalizedEntries
  }, database)
  const playlistId = written.playlistId
  const added = written.entries.filter(entry => entry.addedToPlaylist).length
  const relatedLinksAdded = written.entries.reduce((sum, entry) => sum + entry.relatedLinksAdded, 0)
  const lastVideoId = written.entries.at(-1)?.videoId
  return {
    playlistId,
    added,
    relatedLinksAdded,
    entries: written.entries.map((entry) => ({
      videoId: entry.videoId,
      created: entry.created,
      membershipAdded: entry.membershipAdded,
      addedToPlaylist: entry.addedToPlaylist,
      alreadyInPlaylist: entry.alreadyInPlaylist,
      relatedLinksAdded: entry.relatedLinksAdded
    })),
    versions: {
      P: readPlaylistAggregateVersion(playlistId, database)!,
      L: { generation: 1, revision: library.revision },
      V: lastVideoId == null ? undefined : readVideoAggregateVersion(lastVideoId, database) ?? undefined
    }
  }
}
