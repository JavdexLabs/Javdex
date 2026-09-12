export const UPLOAD_PURPOSES = [
  'videoCover',
  'videoSample',
  'actressAvatar',
  'actressGallery',
  'classificationImage',
  'playlistCover',
  'pendingScrapeStaging'
] as const

export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number]

export type CatalogImageRef =
  | { kind: 'upload'; uploadId: string }
  | { kind: 'asset'; assetId: number }
  | { kind: 'clear' }

export type DesktopImageRef =
  | { kind: 'desktopTemp'; handle: string }
  | { kind: 'asset'; assetId: number }
  | { kind: 'clear' }

export interface UploadCreateInput {
  purpose: UploadPurpose
  contentType: string
}

export interface UploadCreateResult {
  uploadId: string
  expiresAt: string
  maxBytes: number
}

export interface UploadInspectResult {
  uploadId: string
  purpose: UploadPurpose
  contentType: string
  byteLength: number
  sha256: string
  width: number
  height: number
  consumed: boolean
  expiresAt: string
}
