import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { nativeImage } from 'electron'
import type { ImageDimensions } from './types'
import { readImageOrientationFromBuffer } from './imageOrientation'

/** Content fingerprint for image bytes (first 16 hex of sha256). */
export function avatarSourceFingerprint(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16)
}

export function detectImageExtensionFromBuffer(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return '.jpg'
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return '.png'
  }
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return '.gif'
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return '.webp'
  }
  if (buf.length >= 16 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brands = buf.toString('ascii', 8, Math.min(buf.length, 40))
    if (brands.includes('avif') || brands.includes('avis')) return '.avif'
  }
  return null
}

function hasImageMagicBytes(buf: Buffer): boolean {
  return detectImageExtensionFromBuffer(buf) !== null
}

export function isUsableImageBuffer(body: Buffer): boolean {
  if (body.length === 0) return false
  if (body[0] === 0x3c || body[0] === 0x7b) return false

  if (typeof nativeImage?.createFromBuffer === 'function') {
    const img = nativeImage.createFromBuffer(body)
    if (!img.isEmpty()) {
      const { width, height } = img.getSize()
      if (width > 0 && height > 0) return true
    }
  }

  return hasImageMagicBytes(body)
}

function readNativeImageSize(img: Electron.NativeImage): ImageDimensions | null {
  if (img.isEmpty()) return null
  const { width, height } = img.getSize()
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

function applyExifOrientation(
  width: number,
  height: number,
  orientation: number | null
): ImageDimensions {
  if (orientation != null && orientation >= 5 && orientation <= 8) {
    return { width: height, height: width }
  }
  return { width, height }
}

function readImageDimensionsFromBufferFallback(data: Buffer): ImageDimensions | null {
  if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    const width = data.readUInt32BE(16)
    const height = data.readUInt32BE(20)
    if (width > 0 && height > 0) return { width, height }
    return null
  }

  if (data.length >= 10 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    const width = data.readUInt16LE(6)
    const height = data.readUInt16LE(8)
    if (width > 0 && height > 0) return { width, height }
    return null
  }

  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    const orientation = readImageOrientationFromBuffer(data)
    let offset = 2
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = data[offset + 1]
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2
        continue
      }
      const segmentLength = data.readUInt16BE(offset + 2)
      if (segmentLength < 2 || offset + 2 + segmentLength > data.length) break
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = data.readUInt16BE(offset + 5)
        const width = data.readUInt16BE(offset + 7)
        if (width > 0 && height > 0) {
          return applyExifOrientation(width, height, orientation)
        }
        return null
      }
      offset += 2 + segmentLength
    }
  }

  return null
}

/** Read image dimensions from an in-memory image buffer. */
export function readImageDimensionsFromBuffer(data: Buffer): ImageDimensions | null {
  try {
    if (typeof nativeImage?.createFromBuffer === 'function') {
      const fromNative = readNativeImageSize(nativeImage.createFromBuffer(data))
      if (fromNative) return fromNative
    }
  } catch {
    // fall through to header parsing
  }
  return readImageDimensionsFromBufferFallback(data)
}

/** Read image dimensions from a local file without loading it into the renderer. */
export function readImageDimensionsFromPath(filePath: string): ImageDimensions | null {
  try {
    if (!fs.existsSync(filePath)) return null
    if (typeof nativeImage?.createFromPath === 'function') {
      const fromNative = readNativeImageSize(nativeImage.createFromPath(filePath))
      if (fromNative) return fromNative
    }
    return readImageDimensionsFromBufferFallback(fs.readFileSync(filePath))
  } catch {
    return null
  }
}
