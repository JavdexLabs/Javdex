/** Encode a facet label for a URL path segment (HashRouter-safe). */
export function encodeFacetValueKey(value: string): string {
  return encodeURIComponent(value)
}

export function decodeFacetValueKey(valueKey: string | undefined): string {
  if (!valueKey) return ''
  try {
    return decodeURIComponent(valueKey)
  } catch {
    return valueKey
  }
}

export function facetVideoListPath(facetType: string, value: string): string {
  return `/facet/${facetType}/v/${encodeFacetValueKey(value)}`
}

export function facetListPath(facetType: string): string {
  return `/facet/${facetType}`
}

export function facetVideoDetailPath(facetType: string, value: string, videoId: number): string {
  return `${facetVideoListPath(facetType, value)}/${videoId}`
}

const FACET_IN_VIDEO_LIST =
  /^\/facet\/([^/]+)\/v\/([^/]+)(?:\/(\d+)(?:\/actress\/(\d+))?)?\/?$/

export function parseFacetVideoPath(pathname: string): {
  facetType: string
  valueKey: string
  videoId?: number
  actressId?: number
} | null {
  const m = pathname.match(FACET_IN_VIDEO_LIST)
  if (!m) return null
  const videoId = m[3] ? Number(m[3]) : undefined
  const actressId = m[4] ? Number(m[4]) : undefined
  return {
    facetType: m[1],
    valueKey: m[2],
    videoId: videoId != null && !Number.isNaN(videoId) ? videoId : undefined,
    actressId: actressId != null && !Number.isNaN(actressId) ? actressId : undefined
  }
}
