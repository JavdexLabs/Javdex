const PLAYLIST_IN_TREE = /^\/playlists\/(\d+)(?:\/(\d+)(?:\/actress\/(\d+))?)?\/?$/

export function playlistDetailPath(playlistId: number): string {
  return `/playlists/${playlistId}`
}

export function playlistVideoDetailPath(playlistId: number, videoId: number): string {
  return `/playlists/${playlistId}/${videoId}`
}

export function parsePlaylistVideoPath(pathname: string): {
  playlistId: number
  videoId?: number
  actressId?: number
} | null {
  const m = pathname.match(PLAYLIST_IN_TREE)
  if (!m) return null
  const playlistId = Number(m[1])
  if (Number.isNaN(playlistId)) return null
  const videoId = m[2] ? Number(m[2]) : undefined
  const actressId = m[3] ? Number(m[3]) : undefined
  return {
    playlistId,
    videoId: videoId != null && !Number.isNaN(videoId) ? videoId : undefined,
    actressId: actressId != null && !Number.isNaN(actressId) ? actressId : undefined
  }
}
