export function actressDetailPath(actressId: number): string {
  return `/actresses/${actressId}`
}

export function actressVideoDetailPath(actressId: number, videoId: number): string {
  return `/actresses/${actressId}/${videoId}`
}

export function actressVideoActressPath(
  actressId: number,
  videoId: number,
  stackedActressId: number
): string {
  return `/actresses/${actressId}/${videoId}/actress/${stackedActressId}`
}

const ACTRESS_VIDEO_PATH = /^\/actresses\/(\d+)(?:\/(\d+)(?:\/actress\/(\d+))?)?\/?$/

export function parseActressVideoPath(pathname: string): {
  actressId: number
  videoId?: number
  stackedActressId?: number
} | null {
  const match = pathname.match(ACTRESS_VIDEO_PATH)
  if (!match) return null

  const actressId = Number(match[1])
  if (Number.isNaN(actressId)) return null

  const videoId = match[2] ? Number(match[2]) : undefined
  if (videoId != null && Number.isNaN(videoId)) return null

  const stackedActressId = match[3] ? Number(match[3]) : undefined
  if (stackedActressId != null && Number.isNaN(stackedActressId)) return null

  return { actressId, videoId, stackedActressId }
}
