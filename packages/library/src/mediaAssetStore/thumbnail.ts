import sharp from 'sharp'
import type { ImageThumbnailSize } from '@shared/imageVariants'
import { AssetReadQueue } from './readQueue'
import { MAX_ASSET_PIXELS } from './pixelBudget'

// Only requests already admitted by the four-slot file queue reach this queue.
const decodes = new AssetReadQueue(2, 4)

export function createAssetThumbnail(body: Buffer, size: ImageThumbnailSize, signal?: AbortSignal): Promise<Buffer> {
  return decodes.run(async () => {
    signal?.throwIfAborted()
    const image = sharp(body, { limitInputPixels: MAX_ASSET_PIXELS, pages: 1 })
      .rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 3 })
    try {
      const thumbnail = await image.toBuffer()
      signal?.throwIfAborted()
      return thumbnail
    } finally {
      image.destroy()
    }
  }, signal)
}
