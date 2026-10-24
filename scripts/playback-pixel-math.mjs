// Mean byte values from the acceptance runner's 5x5 pixel patches.
export const patchSamples = 25
// Recover the integer sums before subtraction. Repeated byte/25 additions can
// turn exactly 3 into 3.0000000000000284; a real 3.04 still exceeds the gate.
export const meanByteDifference = (left, right) => Math.abs(Math.round(left * patchSamples) - Math.round(right * patchSamples)) / patchSamples

// An SDR byte output may quantize a <1-code reference step to the same value.
// Preserve order, and still require every resolvable reference step to change.
export function grayRampResolved(actual, expected) {
  return actual.length === expected.length && actual.length > 1
    && actual.every((value, i) => Number.isFinite(value) && Number.isFinite(expected[i]) && (i === 0
      || value >= actual[i - 1] && (expected[i] - expected[i - 1] < 1 || value > actual[i - 1])))
}

// A position has one filtered edge; width/height can accumulate the rounding
// of both edges when the bright-pixel bounds exclude their antialias fringe.
export function bitmapBoundsMatch(actual, expected, scale) {
  if (!actual || !Number.isFinite(scale) || scale <= 0) return false
  return ['x', 'y', 'width', 'height'].every(key => Number.isFinite(actual[key]) && Number.isFinite(expected[key])
    && Math.abs(actual[key] - expected[key]) <= Math.max(3, Math.ceil(scale * (key === 'width' || key === 'height' ? 2 : 1))))
}

export function sampleColorPatches(bytes, width, height, bgra = false) {
  const scale = Math.min(width / 16, height / 9), ox = (width - 16 * scale) / 2, oy = (height - 9 * scale) / 2
  return [.25, .75].map(v => Array.from({ length: 8 }, (_, index) => {
    const x = Math.floor(ox + 16 * scale * (index + .5) / 8), y = Math.floor(oy + 9 * scale * v), sum = [0, 0, 0]
    if (x < 2 || y < 2 || x + 2 >= width || y + 2 >= height || bytes.length !== width * height * 4) throw new Error('Incomplete color patch pixels')
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const at = ((y + dy) * width + x + dx) * 4
      for (let c = 0; c < 3; c++) sum[c] += bytes[at + (bgra ? 2 - c : c)]
    }
    return sum.map(value => value / 25)
  }))
}
