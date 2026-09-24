import { nativeImage, type NativeImage } from 'electron'
import { readImageOrientationFromBuffer } from '@library/mediaAssetStore'

export type CoverImageDecoder = (bytes: Buffer) => NativeImage

export interface CoverArtworkRecipe {
  readonly version: 1
  readonly sourceWidth: number
  readonly sourceHeight: number
  readonly orientation: number
  readonly crop?: Readonly<{ x: number; y: number; width: number; height: number }>
  readonly encoding: 'original' | 'jpeg' | 'png'
}

interface CoverArtwork {
  kind: 'cover' | 'landscape'
  recipe?: CoverArtworkRecipe
  extension: string
  bytes: number
  warning?: string
}

function decodeImage(bytes: Buffer, decode: CoverImageDecoder): NativeImage {
  const image = decode(bytes)
  const { width, height } = image.getSize()
  if (image.isEmpty() || width <= 0 || height <= 0) throw new Error('封面无法解码')
  return image
}

/** nativeImage ignores EXIF. Move whole pixels without depending on platform channel order. */
function orientImage(image: NativeImage, orientation: number): NativeImage {
  if (orientation === 1) return image
  const { width, height } = image.getSize()
  const swapped = orientation >= 5
  const outputWidth = swapped ? height : width
  const outputHeight = swapped ? width : height
  const source = image.toBitmap()
  const output = Buffer.alloc(source.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let dx = x
      let dy = y
      switch (orientation) {
        case 2: dx = width - 1 - x; break
        case 3: dx = width - 1 - x; dy = height - 1 - y; break
        case 4: dy = height - 1 - y; break
        case 5: dx = y; dy = x; break
        case 6: dx = height - 1 - y; dy = x; break
        case 7: dx = height - 1 - y; dy = width - 1 - x; break
        case 8: dx = y; dy = width - 1 - x; break
      }
      source.copy(output, (dy * outputWidth + dx) * 4, (y * width + x) * 4, (y * width + x + 1) * 4)
    }
  }
  return nativeImage.createFromBitmap(output, { width: outputWidth, height: outputHeight })
}

function encode(bytes: Buffer, image: NativeImage, recipe: CoverArtworkRecipe): Buffer {
  if (recipe.encoding === 'original') return bytes
  const cropped = recipe.crop ? image.crop(recipe.crop) : image
  const output = recipe.encoding === 'png' ? cropped.toPNG() : cropped.toJPEG(85)
  if (output.length === 0) throw new Error('封面编码失败')
  return output
}

/** Prepare exact output sizes, then discard pixels/encoded buffers. Plans retain only recipes. */
export function prepareCoverArtwork(
  bytes: Buffer,
  extension: string,
  decode: CoverImageDecoder = nativeImage.createFromBuffer
): CoverArtwork[] {
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(extension)) throw new Error('不支持的封面格式')
  const source = decodeImage(bytes, decode)
  const { width: sourceWidth, height: sourceHeight } = source.getSize()
  const orientation = readImageOrientationFromBuffer(bytes)
  const image = orientImage(source, orientation)
  const { width, height } = image.getSize()
  const format = extension === '.png' ? 'png' : 'jpeg'
  const original = orientation === 1 && extension !== '.webp'
  const base: CoverArtworkRecipe = {
    version: 1, sourceWidth, sourceHeight, orientation,
    encoding: original ? 'original' : format
  }
  const outputExtension = format === 'png' ? '.png' : '.jpg'
  const artifact = (kind: CoverArtwork['kind'], recipe: CoverArtworkRecipe, warning?: string): CoverArtwork => ({
    kind, recipe: Object.freeze(recipe), extension: outputExtension,
    bytes: encode(bytes, image, recipe).length, ...(warning ? { warning } : {})
  })
  if (width <= height) {
    return [artifact('cover', base, width === height ? '封面为正方形，保留原比例作为海报。' : undefined)]
  }
  const landscape = artifact('landscape', base)
  try {
    const unit = Math.floor(Math.min(width / 2, height / 3))
    if (unit < 1) throw new Error('封面尺寸过小，无法裁剪竖版海报')
    const crop = Object.freeze({ x: width - unit * 2, y: Math.floor((height - unit * 3) / 2), width: unit * 2, height: unit * 3 })
    return [artifact('cover', { ...base, encoding: format, crop }), landscape]
  } catch {
    return [{ kind: 'cover', extension: outputExtension, bytes: 0, warning: '竖版海报无法裁剪或编码，已保留完整横版封面。' }, landscape]
  }
}

export function renderCoverArtwork(
  bytes: Buffer,
  recipe: CoverArtworkRecipe,
  decode: CoverImageDecoder = nativeImage.createFromBuffer
): Buffer {
  // Source hash was checked by the exporter; never rediscover orientation or crop at apply time.
  if (recipe.encoding === 'original') return bytes
  const source = decodeImage(bytes, decode)
  const size = source.getSize()
  if (size.width !== recipe.sourceWidth || size.height !== recipe.sourceHeight) throw new Error('封面尺寸已变化')
  return encode(bytes, orientImage(source, recipe.orientation), recipe)
}
