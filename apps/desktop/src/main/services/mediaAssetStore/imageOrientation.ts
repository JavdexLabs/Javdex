/** Read IFD0 orientation only, bounded to the metadata chunk rather than the image. */
function tiffOrientation(input: Buffer): number | null {
  const data = input.subarray(input.subarray(0, 6).equals(Buffer.from('Exif\0\0')) ? 6 : 0)
  if (data.length < 8) return null
  const order = data.toString('ascii', 0, 2)
  if (order !== 'II' && order !== 'MM') return null
  const u16 = (offset: number): number => order === 'II' ? data.readUInt16LE(offset) : data.readUInt16BE(offset)
  const u32 = (offset: number): number => order === 'II' ? data.readUInt32LE(offset) : data.readUInt32BE(offset)
  if (u16(2) !== 42) return null
  const start = u32(4)
  if (start < 8 || start + 2 > data.length) return null
  const count = u16(start)
  for (let index = 0; index < count; index++) {
    const entry = start + 2 + index * 12
    if (entry + 12 > data.length) break
    if (u16(entry) !== 0x112 || u16(entry + 2) !== 3 || u32(entry + 4) !== 1) continue
    const value = u16(entry + 8)
    return value >= 1 && value <= 8 ? value : null
  }
  return null
}

/** JPEG APP1, PNG eXIf and WebP EXIF all contain the same bounded TIFF structure. */
export function readImageOrientationFromBuffer(data: Buffer): number {
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2
    while (offset + 4 <= data.length && data[offset] === 0xff) {
      const marker = data[offset + 1]
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0xff) { offset++; continue }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { offset += 2; continue }
      const length = data.readUInt16BE(offset + 2)
      if (length < 2 || offset + 2 + length > data.length) break
      if (marker === 0xe1 && data.toString('ascii', offset + 4, offset + 10) === 'Exif\0\0') {
        const orientation = tiffOrientation(data.subarray(offset + 4, offset + 2 + length))
        if (orientation != null) return orientation
      }
      offset += 2 + length
    }
  } else if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    for (let offset = 8; offset + 12 <= data.length;) {
      const length = data.readUInt32BE(offset)
      if (offset + 12 + length > data.length) break
      if (data.toString('ascii', offset + 4, offset + 8) === 'eXIf') {
        return tiffOrientation(data.subarray(offset + 8, offset + 8 + length)) ?? 1
      }
      offset += 12 + length
    }
  } else if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const end = Math.min(data.length, 8 + data.readUInt32LE(4))
    for (let offset = 12; offset + 8 <= end;) {
      const length = data.readUInt32LE(offset + 4)
      if (offset + 8 + length > end) break
      if (data.toString('ascii', offset, offset + 4) === 'EXIF') {
        return tiffOrientation(data.subarray(offset + 8, offset + 8 + length)) ?? 1
      }
      offset += 8 + length + (length % 2)
    }
  }
  return 1
}
