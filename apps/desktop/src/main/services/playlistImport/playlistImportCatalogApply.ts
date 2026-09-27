import { randomUUID } from 'node:crypto'
import type { PlaylistImportOutcome } from '@shared/playlistImportTypes'
import type { CatalogBackend } from '../../application/catalogBackend'
import { ipcMutation } from '../../application/mutationContext'
import {
  PlaylistImportRepository,
  PlaylistImportTargetError
} from './playlistImportRepository'

export async function applyPlaylistImportThroughCatalog(
  catalog: CatalogBackend,
  repository: PlaylistImportRepository,
  runId: string,
  applyIdempotencyKey: string
): Promise<PlaylistImportOutcome> {
  try {
    const completed = repository.snapshot(runId)
    if (completed?.phase === 'completed' && completed.outcome) {
      return completed.outcome
    }
    const plan = repository.prepareRemoteApply(runId, applyIdempotencyKey)
    const library = (await catalog.libraries.get({ libraryId: plan.libraryId })) as {
      revision?: number
      status?: string
    } | null
    if (!library || typeof library.status !== 'string' || library.status !== 'active') {
      throw new PlaylistImportTargetError(
        library ? 'TARGET_LIBRARY_ARCHIVED' : 'TARGET_LIBRARY_NOT_FOUND',
        library ? '目标媒体库已归档，无法完成导入。' : '目标媒体库已不存在，无法完成导入。'
      )
    }
    if (typeof library.revision !== 'number') {
      throw new Error('目标媒体库缺少 revision，无法提交远程导入。')
    }
    const first = plan.videoIds[0] == null
      ? null
      : (await catalog.queries.getVideo({
          scope: { kind: 'all' },
          videoId: plan.videoIds[0]
        })) as { generation?: number; revision?: number } | null
    if (plan.videoIds[0] != null && !first) throw new Error('MATCH_SNAPSHOT_STALE')
    let operationId = repository.catalogApplyOperationId(runId, applyIdempotencyKey)
    if (!operationId) {
      operationId = randomUUID()
      repository.rememberCatalogApplyOperation(runId, applyIdempotencyKey, operationId)
    }
    const result = (await catalog.playlists.applyImport(
      {
        name: plan.name,
        entries: plan.entries,
        libraryId: plan.libraryId,
        ...(plan.sourceUrl ? { sourceUrl: plan.sourceUrl } : {}),
      },
      ipcMutation(operationId, {
        L: { generation: 1, revision: library.revision },
        ...(first ? { V: { generation: first.generation ?? 1, revision: first.revision ?? 1 } } : {})
      })
    )) as { playlistId: number; added?: number; relatedLinksAdded?: number }
    const created = (await catalog.playlists.get({ playlistId: result.playlistId })) as {
      name?: string
    } | null
    return repository.commitRemoteApply(runId, applyIdempotencyKey, {
      playlistId: result.playlistId,
      added: result.added ?? plan.entries.length,
      playlistName: created?.name ?? plan.name,
      relatedLinksAdded: result.relatedLinksAdded,
      entries: (result as { entries?: Array<{
        videoId: number
        created: boolean
        membershipAdded: boolean
        addedToPlaylist: boolean
        alreadyInPlaylist: boolean
        relatedLinksAdded: number
      }> }).entries
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'IMPORT_PREVIEW_STALE') throw error
    throw error
  }
}
