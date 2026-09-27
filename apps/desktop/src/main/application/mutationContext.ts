import { randomUUID } from 'node:crypto'
import type { CatalogBackend, MutationContext } from './catalogBackend'
import type { ExpectedVersions } from '@shared/protocol/versions'
import { structuredError } from '@shared/protocol/errors'

export function ipcMutation(
  operationId?: string,
  expectedVersions: ExpectedVersions = {}
): MutationContext {
  return {
    operationId: operationId ?? randomUUID(),
    expectedVersions
  }
}

/**
 * A few legacy IPC commands predate optimistic version arguments.  Remote
 * servers still require the canonical aggregate version, so resolve it at the
 * command boundary when an older renderer does not provide one.  New callers
 * keep their supplied version and therefore retain stale-write protection.
 */
export async function ipcVideoMutation(
  backend: CatalogBackend,
  videoId: number,
  expectedVersions?: ExpectedVersions
): Promise<MutationContext> {
  if (expectedVersions?.V) return ipcMutation(undefined, expectedVersions)
  if (backend.mode !== 'remote') return ipcMutation(undefined, expectedVersions)
  const video = await backend.queries.getVideo({ scope: { kind: 'all' }, videoId })
  if (!video || video.generation == null || video.revision == null) {
    throw structuredError('INVALID_INPUT', '无法读取影片版本，请刷新后重试')
  }
  return ipcMutation(undefined, {
    ...expectedVersions,
    V: { generation: video.generation, revision: video.revision }
  })
}

export async function ipcActressMutation(
  backend: CatalogBackend,
  actressId: number,
  expectedVersions?: ExpectedVersions
): Promise<MutationContext> {
  if (expectedVersions?.A) return ipcMutation(undefined, expectedVersions)
  if (backend.mode !== 'remote') return ipcMutation(undefined, expectedVersions)
  const actress = await backend.actresses.get({ actressId })
  if (!actress || actress.generation == null || actress.revision == null) {
    throw structuredError('INVALID_INPUT', '无法读取演员版本，请刷新后重试')
  }
  return ipcMutation(undefined, {
    ...expectedVersions,
    A: { generation: actress.generation, revision: actress.revision }
  })
}

/** Legacy playlist IPC only carries IDs; remote writes also require the playlist's P version. */
export async function ipcPlaylistMutation(backend: CatalogBackend, playlistId: number, expectedVersions?: ExpectedVersions): Promise<MutationContext> {
  if (expectedVersions?.P) return ipcMutation(undefined, expectedVersions)
  if (backend.mode !== 'remote') return ipcMutation()
  const playlist = await backend.playlists.metadata({ playlistId })
  if (!playlist) throw structuredError('INVALID_INPUT', '清单不存在')
  if (playlist.generation == null || playlist.revision == null) {
    throw structuredError('INVALID_INPUT', '无法读取清单版本，请刷新后重试')
  }
  return ipcMutation(undefined, {
    P: { generation: playlist.generation, revision: playlist.revision }
  })
}
