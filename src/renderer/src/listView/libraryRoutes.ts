export function libraryVideoDetailPath(videoId: number): string {
  return `/detail/${videoId}`
}

export function libraryVideoActressPath(videoId: number, actressId: number): string {
  return `${libraryVideoDetailPath(videoId)}/actress/${actressId}`
}

const LIBRARY_VIDEO_PATH = /^\/detail\/(\d+)(?:\/actress\/(\d+))?\/?$/

export function parseLibraryVideoPath(pathname: string): {
  videoId: number
  actressId?: number
} | null {
  const match = pathname.match(LIBRARY_VIDEO_PATH)
  if (!match) return null

  const videoId = Number(match[1])
  if (Number.isNaN(videoId)) return null

  const actressId = match[2] ? Number(match[2]) : undefined
  if (actressId != null && Number.isNaN(actressId)) return null

  return { videoId, actressId }
}

