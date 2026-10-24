import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

// Serialized into the isolated acceptance main process. Do not close over
// module imports: the same function is exercised with a real IPC-like seam.
export function installCanvasSubmissionObserver({ ipcMain, BrowserWindow }) {
  const contents = BrowserWindow.getAllWindows()[0].webContents
  globalThis.windowsCanvasReceipts = new Map()
  ipcMain.on('playback:shared-texture-submitted', (event, data) => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame
      || !data || typeof data.surfaceToken !== 'string' || !/^[\da-f-]{36}$/.test(data.surfaceToken)
      || !Number.isSafeInteger(data.sequence) || data.sequence < 1) return
    const receipts = globalThis.windowsCanvasReceipts
    const previous = receipts.get(data.surfaceToken)
    if (previous && data.sequence <= previous.sequence) return
    if (!previous && receipts.size >= 10) receipts.delete(receipts.keys().next().value)
    receipts.set(data.surfaceToken, { count: (previous?.count ?? 0) + 1, sequence: data.sequence })
  })
}

/** The testsrc2 fixture contains bright, saturated red/green/blue regions and
 * animated pixels. This is an obvious-black/frozen-output check, not colorimetry. */
export function checkSyntheticCanvasFrame({ width, height, data }, previousHash) {
  assert.ok(Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0)
  assert.equal(data.length, width * height * 4, 'Canvas capture must contain complete BGRA pixels')
  let samples = 0, visible = 0, opaque = 0, red = 0, green = 0, blue = 0
  const stride = Math.max(1, Math.ceil(width * height / 4096))
  for (let pixel = 0; pixel < width * height; pixel += stride) {
    const [b, g, r, a] = data.subarray(pixel * 4, pixel * 4 + 4)
    samples++; if (a >= 250) opaque++
    if (Math.max(r, g, b) > 32) visible++
    if (r > 96 && r > g + 48 && r > b + 48) red++
    if (g > 96 && g > r + 48 && g > b + 48) green++
    if (b > 96 && b > r + 48 && b > g + 48) blue++
  }
  assert.ok(opaque >= samples * .99, 'Synthetic video must be opaque')
  assert.ok(visible > samples * .15 && red > 4 && green > 4 && blue > 4,
    'Synthetic video must show its expected colored regions, not black/blank output')
  const hash = createHash('sha256').update(data).digest('hex')
  if (previousHash !== undefined) assert.notEqual(hash, previousHash, 'Animated synthetic Canvas pixels must advance')
  return { samples, visible, opaque, red, green, blue, hash }
}
