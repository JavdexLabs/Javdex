import sharp from 'sharp'

/** Per-frame canvas budget. Animation lifetime and concurrent decoded memory are separate. */
export const MAX_ASSET_PIXELS = 64 * 1024 * 1024

export class AssetPixelLimitError extends Error {
  constructor() {
    super('Image asset exceeds the pixel limit')
    this.name = 'AssetPixelLimitError'
  }
}

const SERVED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])

/** Read headers asynchronously; never decode pixels just to determine allocation limits. */
export async function inspectServedImage(body: Buffer, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  // metadata does not decode pixels. Disable its default limit so oversize failures use our typed error.
  // Any future resize/decode must separately set limitInputPixels to MAX_ASSET_PIXELS.
  const reader = sharp(body, { limitInputPixels: false, pages: 1 })
  try {
    const metadata = await reader.metadata()
    signal?.throwIfAborted()
    const { width, height, mediaType } = metadata
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
      throw new Error('Invalid image dimensions')
    }
    if (width > MAX_ASSET_PIXELS / height) throw new AssetPixelLimitError()
    if (!mediaType || !SERVED_TYPES.has(mediaType)) throw new Error('Unsupported image format')
    return mediaType
  } finally {
    reader.destroy()
  }
}
