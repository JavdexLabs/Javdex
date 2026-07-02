import type { ActressGalleryAsset, VideoAsset } from './types'
import {
  detailBackgroundPathFromAsset,
  firstActressGalleryForDisplay,
  firstVideoSampleForDisplay
} from './mediaGalleryDisplay'

/** Resolve detail-page background path; poster_path always wins when set. */
export function resolveVideoDetailDisplayBackgroundPath(
  video: { poster_path: string | null; assets: VideoAsset[] },
  useFirstSampleFallback: boolean
): string | null {
  const poster = video.poster_path?.trim()
  if (poster) return poster
  if (!useFirstSampleFallback) return null
  const first = firstVideoSampleForDisplay(video.assets)
  return first ? detailBackgroundPathFromAsset(first) : null
}

/** Resolve detail-page background path; poster_path always wins when set. */
export function resolveActressDetailDisplayBackgroundPath(
  actress: { poster_path: string | null; gallery: ActressGalleryAsset[] },
  useFirstGalleryFallback: boolean
): string | null {
  const poster = actress.poster_path?.trim()
  if (poster) return poster
  if (!useFirstGalleryFallback) return null
  const first = firstActressGalleryForDisplay(actress.gallery)
  return first ? detailBackgroundPathFromAsset(first) : null
}
