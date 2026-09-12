export type ImageThumbnailSize = 320 | 640 | 1280

export function parseImageThumbnailSize(value: string | null): ImageThumbnailSize | undefined {
  if (value === null) return undefined
  if (value === '320' || value === '640' || value === '1280') return Number(value) as ImageThumbnailSize
  throw new Error('Invalid image size')
}

/** Add a finite image variant without changing the original preview URL. */
export function imageThumbnailUrl(src: string, size: ImageThumbnailSize): string {
  // Only app-owned URLs implement the size contract. Preserve remote/data/blob sources.
  if ((!src.startsWith('/') && !src.startsWith('media://')) || src.startsWith('//')) return src
  const url = new URL(src, 'http://image.invalid')
  url.searchParams.set('size', String(size))
  return src.startsWith('/') ? url.pathname + url.search + url.hash : url.toString()
}
