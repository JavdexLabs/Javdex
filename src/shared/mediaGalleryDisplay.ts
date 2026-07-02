import type { ActressGalleryAsset, VideoAsset } from './types'

export const GALLERY_FALLBACK_RATIO = 3 / 4
export const SAMPLE_FALLBACK_RATIO = 16 / 9

export function actressGalleryRatio(
  asset: Pick<ActressGalleryAsset, 'width' | 'height'>
): number {
  if (!asset.width || !asset.height || asset.width <= 0 || asset.height <= 0) {
    return GALLERY_FALLBACK_RATIO
  }
  const ratio = asset.width / asset.height
  return Number.isFinite(ratio) && ratio > 0 ? ratio : GALLERY_FALLBACK_RATIO
}

export function hasActressGalleryDisplaySource(
  asset: Pick<ActressGalleryAsset, 'local_path' | 'remote_url'>
): boolean {
  return Boolean(asset.local_path?.trim() || asset.remote_url?.trim())
}

/** Display-only: landscape first, then portrait; keeps scrape/import position within each group. */
export function sortActressGalleryForDisplay<T extends ActressGalleryAsset>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const landscapeA = actressGalleryRatio(a) > 1 ? 0 : 1
    const landscapeB = actressGalleryRatio(b) > 1 ? 0 : 1
    if (landscapeA !== landscapeB) return landscapeA - landscapeB
    return a.position - b.position || a.id - b.id
  })
}

export function prepareActressGalleryForDisplay<T extends ActressGalleryAsset>(items: T[]): T[] {
  return sortActressGalleryForDisplay(items.filter(hasActressGalleryDisplaySource))
}

export function firstActressGalleryForDisplay<T extends ActressGalleryAsset>(items: T[]): T | null {
  return prepareActressGalleryForDisplay(items)[0] ?? null
}

export function hasVideoSampleDisplaySource(
  asset: Pick<VideoAsset, 'local_path' | 'remote_url'>
): boolean {
  return Boolean(asset.local_path?.trim() || asset.remote_url?.trim())
}

export function prepareVideoSamplesForDisplay(assets: VideoAsset[]): VideoAsset[] {
  return assets
    .filter((asset) => asset.type === 'sample')
    .filter(hasVideoSampleDisplaySource)
    .sort((a, b) => a.position - b.position)
}

export function firstVideoSampleForDisplay(assets: VideoAsset[]): VideoAsset | null {
  return prepareVideoSamplesForDisplay(assets)[0] ?? null
}

/** Path stored for detail background; prefers local file, falls back to remote URL. */
export function detailBackgroundPathFromAsset(
  asset: Pick<ActressGalleryAsset | VideoAsset, 'local_path' | 'remote_url'>
): string | null {
  return asset.local_path?.trim() || asset.remote_url?.trim() || null
}
