import fs from 'node:fs'
import sharp from 'sharp'
import type { LibraryImageCodec, LibraryImageSize } from '@library/runtime/host'

function sizeFromPng(data: Uint8Array): LibraryImageSize | null {
  if (data.length < 24 || data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4e || data[3] !== 0x47) {
    return null
  }
  const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const width = view.readUInt32BE(16)
  const height = view.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : null
}

function sizeFromGif(data: Uint8Array): LibraryImageSize | null {
  if (data.length < 10 || data[0] !== 0x47 || data[1] !== 0x49 || data[2] !== 0x46) return null
  const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const width = view.readUInt16LE(6)
  const height = view.readUInt16LE(8)
  return width > 0 && height > 0 ? { width, height } : null
}

function sizeFromJpeg(data: Uint8Array): LibraryImageSize | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null
  const view = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  let offset = 2
  while (offset + 9 < view.length) {
    if (view[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = view[offset + 1]
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2
      continue
    }
    const segmentLength = view.readUInt16BE(offset + 2)
    if (segmentLength < 2 || offset + 2 + segmentLength > view.length) break
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = view.readUInt16BE(offset + 5)
      const width = view.readUInt16BE(offset + 7)
      return width > 0 && height > 0 ? { width, height } : null
    }
    offset += 2 + segmentLength
  }
  return null
}

export function createSharpImageCodec(): LibraryImageCodec {
  if (!sharp.versions.sharp) throw new Error('sharp 原生模块不可用')
  return {
    sizeFromBuffer(data) {
      return sizeFromPng(data) ?? sizeFromGif(data) ?? sizeFromJpeg(data)
    },
    sizeFromPath(filePath) {
      return this.sizeFromBuffer(fs.readFileSync(filePath))
    }
  }
}

export async function assertSharpDecode(): Promise<void> {
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 12, g: 34, b: 56 } }
  })
    .png()
    .toBuffer()
  const metadata = await sharp(png).metadata()
  if (metadata.width !== 2 || metadata.height !== 2) {
    throw new Error('sharp 解码失败')
  }
}
