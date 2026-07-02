import type {
  Playlist,
  PlaylistCreateInput,
  PlaylistDetail,
  PlaylistListItem,
  PlaylistUpdateInput,
  PlaylistVideoSortBy,
  PlaylistVideoSortDir,
  PlaylistVideoMembership
} from '@shared/types'
import { getDb } from './database'

type PlaylistVideoTarget = { playlistId: number; videoId: number }
type PlaylistVideoSort = { sortBy?: PlaylistVideoSortBy; sortDir?: PlaylistVideoSortDir }

function nowIso(): string {
  return new Date().toISOString()
}

function normalizePlaylistInput(input: PlaylistCreateInput): {
  name: string
  description: string | null
} {
  const name = input.name.trim()
  if (!name) throw new Error('清单名称不能为空')
  return {
    name,
    description: input.description?.trim() || null
  }
}

function playlistListSelect(extraSelect = ''): string {
  return `
    SELECT
      p.*,
      COUNT(pv.video_id) AS video_count,
      COALESCE(
        p.cover_path,
        (
          SELECT v.cover_path
          FROM playlist_video pv2
          JOIN videos v ON v.id = pv2.video_id
          WHERE pv2.playlist_id = p.id
            AND v.cover_path IS NOT NULL
            AND trim(v.cover_path) != ''
          ORDER BY pv2.position, pv2.added_at, pv2.video_id
          LIMIT 1
        )
      ) AS preview_cover_path
      ${extraSelect}
    FROM playlists p
    LEFT JOIN playlist_video pv ON pv.playlist_id = p.id
  `
}

export function createPlaylistRecord(
  input: PlaylistCreateInput,
  coverRelPath?: string | null
): number {
  const db = getDb()
  const normalized = normalizePlaylistInput(input)
  const createdAt = nowIso()
  const info = db
    .prepare(
      `INSERT INTO playlists (name, description, cover_path, created_at, updated_at)
       VALUES (@name, @description, @coverPath, @createdAt, @updatedAt)`
    )
    .run({
      ...normalized,
      coverPath: coverRelPath ?? null,
      createdAt,
      updatedAt: createdAt
    })
  return Number(info.lastInsertRowid)
}

export function updatePlaylistRecord(
  id: number,
  input: PlaylistUpdateInput,
  coverRelPath?: string | null
): string | null {
  const db = getDb()
  const current = getPlaylistById(id)
  if (!current) return null

  const normalized = normalizePlaylistInput(input)
  const shouldUpdateCover = input.removeCover === true || coverRelPath !== undefined
  const nextCoverPath = input.removeCover ? null : coverRelPath

  db.prepare(
    `UPDATE playlists
     SET name = @name,
         description = @description,
         cover_path = CASE WHEN @shouldUpdateCover THEN @coverPath ELSE cover_path END,
         updated_at = @updatedAt
     WHERE id = @id`
  ).run({
    id,
    ...normalized,
    shouldUpdateCover: shouldUpdateCover ? 1 : 0,
    coverPath: nextCoverPath ?? null,
    updatedAt: nowIso()
  })

  return shouldUpdateCover ? current.cover_path : null
}

export function listPlaylists(): PlaylistListItem[] {
  const db = getDb()
  return db
    .prepare(
      `${playlistListSelect()}
       GROUP BY p.id
       ORDER BY p.created_at DESC, p.id DESC`
    )
    .all() as PlaylistListItem[]
}

export function getPlaylistById(id: number): Playlist | null {
  const db = getDb()
  return (db.prepare('SELECT * FROM playlists WHERE id = ?').get(id) as Playlist | undefined) ?? null
}

const PLAYLIST_VIDEO_SORT_COLUMNS: Record<PlaylistVideoSortBy, string> = {
  added_at: 'pv.added_at',
  release_date: 'v.release_date'
}

function playlistVideoOrderBy(sortBy: PlaylistVideoSortBy, sortDir: 'ASC' | 'DESC'): string {
  if (sortBy === 'release_date') {
    return `(v.release_date IS NULL OR trim(v.release_date) = '') ASC,
            v.release_date ${sortDir},
            pv.added_at DESC,
            pv.position DESC,
            pv.video_id DESC`
  }

  return `${PLAYLIST_VIDEO_SORT_COLUMNS.added_at} ${sortDir},
          pv.position ${sortDir},
          pv.video_id ${sortDir}`
}

export function getPlaylistDetail(id: number, sort: PlaylistVideoSort = {}): PlaylistDetail | null {
  const playlist = getPlaylistById(id)
  if (!playlist) return null
  const db = getDb()
  const sortBy = sort.sortBy ?? 'added_at'
  const sortDir = sort.sortDir === 'asc' ? 'ASC' : 'DESC'
  const orderBy = playlistVideoOrderBy(sortBy, sortDir)
  const videos = db
    .prepare(
      `SELECT v.*
       FROM playlist_video pv
       JOIN videos v ON v.id = pv.video_id
       WHERE pv.playlist_id = ?
       ORDER BY ${orderBy}`
    )
    .all(id) as PlaylistDetail['videos']
  return { ...playlist, videos }
}

export function listPlaylistsForVideo(videoId: number): PlaylistVideoMembership[] {
  const db = getDb()
  const rows = db
    .prepare(
      `${playlistListSelect(
        `, CASE WHEN EXISTS (
           SELECT 1 FROM playlist_video pvm
           WHERE pvm.playlist_id = p.id AND pvm.video_id = @videoId
         ) THEN 1 ELSE 0 END AS contains_video`
      )}
       GROUP BY p.id
       ORDER BY p.created_at DESC, p.id DESC`
    )
    .all({ videoId }) as Array<Omit<PlaylistVideoMembership, 'contains_video'> & {
      contains_video: 0 | 1
    }>
  return rows.map((row) => ({ ...row, contains_video: Boolean(row.contains_video) }))
}

export function addVideoToPlaylist({ playlistId, videoId }: PlaylistVideoTarget): boolean {
  const db = getDb()
  const position = (
    db
      .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM playlist_video WHERE playlist_id = ?')
      .get(playlistId) as { n: number }
  ).n
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO playlist_video (playlist_id, video_id, position, added_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(playlistId, videoId, position, nowIso())
  return info.changes > 0
}

export function removeVideoFromPlaylist({ playlistId, videoId }: PlaylistVideoTarget): boolean {
  const db = getDb()
  const info = db
    .prepare('DELETE FROM playlist_video WHERE playlist_id = ? AND video_id = ?')
    .run(playlistId, videoId)
  return info.changes > 0
}

export function deletePlaylistRecord(id: number): string | null {
  const db = getDb()
  const playlist = getPlaylistById(id)
  if (!playlist) return null
  db.prepare('DELETE FROM playlists WHERE id = ?').run(id)
  return playlist.cover_path
}
