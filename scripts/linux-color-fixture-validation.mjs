import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

export function validateColorFixtureFrame(raw, diagnostics, fixture, width, height) {
  assert.equal(raw.length, width * height * 3, 'Unexpected decoded 10-bit fixture layout')
  const tags = Object.fromEntries(['range', 'space', 'primaries', 'trc'].map(key => [key, diagnostics.match(new RegExp(`color_${key}:([^\\s]+)`))?.[1]]))
  assert.deepEqual(tags, { range: fixture.range === 'full' ? 'pc' : 'tv', space: fixture.primaries === 'bt709' ? 'bt709' : 'bt2020nc',
    primaries: fixture.primaries, trc: fixture.trc }, 'Encoded fixture lost its color tags')
  const grayCodes = Array.from({ length: 8 }, (_, i) => raw.readUInt16LE(2 * (Math.floor(height / 4) * width + Math.floor(width * (i + .5) / 8))))
  assert.deepEqual(grayCodes, fixture.codes, 'Lossless fixture changed reference gray/range values')
  return { passed: true, tags, grayCodes, decodedFrameSha256: createHash('sha256').update(raw).digest('hex') }
}

// Decode one encoded frame; inspect codec-propagated tags, not the command-line
// options or a container-side claim. No GUI, package or application data needed.
export function inspectColorFixture(binary, fixture, width, height) {
  const result = spawnSync(binary, ['-hide_banner', '-loglevel', 'info', '-i', fixture.file,
    '-vf', 'showinfo', '-frames:v', '1', '-an', '-pix_fmt', 'yuv420p10le', '-f', 'rawvideo', 'pipe:1'],
  { timeout: 30000, maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr?.toString())
  return validateColorFixtureFrame(result.stdout, result.stderr.toString(), fixture, width, height)
}
