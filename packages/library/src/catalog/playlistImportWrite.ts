import type Database from 'better-sqlite3'
import type { PlaylistImportWriteInput } from '@shared/playlistImportCommit'
import { ensureVideoMembership } from '@library/db/libraryMembershipRepo'
import { appendRelatedLinks } from '@library/db/relatedLinkStore'

/** Formal catalog writes only. Preview validation and transport authorization stay with callers. */
export function writePlaylistImport(input: PlaylistImportWriteInput, database: Database.Database) {
  return database.transaction(() => {
    const library = database.prepare('SELECT status FROM media_libraries WHERE id = ?')
      .get(input.libraryId) as { status: string } | undefined
    if (!library || library.status !== 'active') throw new Error('TARGET_LIBRARY_UNAVAILABLE')
    const at = new Date().toISOString()
    let playlistId: number
    if (input.destination.kind === 'append') {
      playlistId = input.destination.playlistId
      if (!database.prepare('SELECT 1 FROM playlists WHERE id = ?').get(playlistId)) {
        throw new Error('TARGET_PLAYLIST_NOT_FOUND')
      }
    } else {
      const name = input.destination.name.trim()
      if (!name) throw new Error('清单名称不能为空')
      playlistId = Number(database.prepare(
        'INSERT INTO playlists (name, cover_path, created_at, updated_at) VALUES (?, ?, ?, ?)'
      ).run(name, input.destination.coverPath ?? null, at, at).lastInsertRowid)
    }
    const playlistRelatedLinksAdded = appendRelatedLinks(
      database, 'playlist_links', 'playlist_id', playlistId, input.sourceLinks ?? []
    )
    const initialMembers = new Set((database.prepare('SELECT video_id FROM playlist_video WHERE playlist_id = ?')
      .all(playlistId) as Array<{ video_id: number }>).map(row => row.video_id))
    let nextPosition = (database.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM playlist_video WHERE playlist_id = ?')
      .get(playlistId) as { n: number }).n
    const entries = input.entries.map(entry => {
      const created = entry.kind === 'create'
      const videoId = entry.kind === 'existing' ? entry.videoId : Number(database.prepare(
        'INSERT INTO videos (code, title, scraped_status) VALUES (?, ?, 0)'
      ).run(entry.code, entry.title).lastInsertRowid)
      if (!database.prepare('SELECT 1 FROM videos WHERE id = ?').get(videoId)) throw new Error('MATCH_SNAPSHOT_STALE')
      const membershipAdded = (created || input.reusedMembership === 'ensure-target') && ensureVideoMembership({
        libraryId: input.libraryId, videoId, addedVia: 'manual'
      }, database)
      const relatedLinksAdded = appendRelatedLinks(database, 'video_links', 'video_id', videoId, entry.links ?? [])
      const addedToPlaylist = database.prepare(
        'INSERT OR IGNORE INTO playlist_video (playlist_id, video_id, position, added_at) VALUES (?, ?, ?, ?)'
      ).run(playlistId, videoId, nextPosition, at).changes > 0
      if (addedToPlaylist) nextPosition += 1
      return { videoId, created, membershipAdded, relatedLinksAdded, addedToPlaylist,
        alreadyInPlaylist: !addedToPlaylist && initialMembers.has(videoId) }
    })
    return { playlistId, playlistRelatedLinksAdded, entries }
  })()
}
