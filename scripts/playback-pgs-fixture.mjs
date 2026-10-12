// Original geometric bitmap subtitles for acceptance only, not a PGS encoder.
// Segment/RLE field rationale is in BUILTIN_PLAYBACK_SUBTITLE_ACCEPTANCE.md.
export const bitmapFixture = {
  canvas: { width: 640, height: 360 },
  object: { width: 128, height: 40, border: 4, hole: { x: 56, y: 14, width: 16, height: 12 } },
  cues: [{ start: 1, end: 3, x: 96, y: 64 }, { start: 8, end: 20, x: 256, y: 294 }]
}

const u16 = value => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes }
const u24 = value => { const bytes = Buffer.alloc(3); bytes.writeUIntBE(value, 0, 3); return bytes }
const bytes = (...values) => Buffer.from(values)

function segment(seconds, type, payload) {
  const header = Buffer.alloc(13)
  header.write('PG', 0, 'ascii')
  header.writeUInt32BE(seconds * 90000, 2)
  header[10] = type
  header.writeUInt16BE(payload.length, 11)
  return Buffer.concat([header, payload])
}

function composition(number, state, cue) {
  const { canvas } = bitmapFixture
  const header = Buffer.concat([u16(canvas.width), u16(canvas.height), bytes(0x20), u16(number), bytes(state, 0, 0, cue ? 1 : 0)])
  return cue ? Buffer.concat([header, u16(0), bytes(0, 0), u16(cue.x), u16(cue.y)]) : header
}

// Transparent frame and center hole, with a white interior. Every scanline is
// encoded separately and ends explicitly; long runs exercise both RLE forms.
function pixels() {
  const { width, height, border, hole } = bitmapFixture.object
  const rows = []
  const run = (length, index) => length < 64
    ? bytes(0, length | (index ? 0x80 : 0), ...(index ? [index] : []))
    : bytes(0, 0x40 | (index ? 0x80 : 0) | (length >> 8), length & 0xff, ...(index ? [index] : []))
  for (let y = 0; y < height; y++) {
    const row = Array.from({ length: width }, (_, x) => x >= border && x < width - border && y >= border && y < height - border
      && !(x >= hole.x && x < hole.x + hole.width && y >= hole.y && y < hole.y + hole.height) ? 1 : 0)
    let start = 0
    const parts = []
    for (let x = 1; x <= width; x++) if (x === width || row[x] !== row[start]) {
      parts.push(run(x - start, row[start])); start = x
    }
    rows.push(Buffer.concat([...parts, bytes(0, 0)]))
  }
  return Buffer.concat(rows)
}

export function createPgsFixture() {
  const { object, cues } = bitmapFixture
  const rle = pixels()
  const palette = bytes(0, 0, 0, 16, 128, 128, 0, 1, 235, 128, 128, 255)
  const bitmap = Buffer.concat([u16(0), bytes(0, 0xc0), u24(4 + rle.length), u16(object.width), u16(object.height), rle])
  return Buffer.concat(cues.flatMap((cue, index) => {
    const window = Buffer.concat([bytes(1, 0), u16(cue.x), u16(cue.y), u16(object.width), u16(object.height)])
    return [
      segment(cue.start, 0x16, composition(index * 2, 0x80, cue)),
      segment(cue.start, 0x17, window), segment(cue.start, 0x14, palette), segment(cue.start, 0x15, bitmap), segment(cue.start, 0x80, Buffer.alloc(0)),
      segment(cue.end, 0x16, composition(index * 2 + 1, 0, null)), segment(cue.end, 0x80, Buffer.alloc(0))
    ]
  }))
}
