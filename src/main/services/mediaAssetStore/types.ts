/** A function that downloads a URL into a Buffer (session-aware). */
export type AssetFetcher = (url: string) => Promise<Buffer>

/** Pixel dimensions read from an image file or buffer. */
export interface ImageDimensions {
  width: number
  height: number
}

export interface DownloadedImageAsset {
  localPath: string
  width: number | null
  height: number | null
}

export type ImageAssetSubdir =
  | 'covers'
  | 'avatars'
  | 'actress_gallery'
  | 'samples'
  | 'playlist_covers'
