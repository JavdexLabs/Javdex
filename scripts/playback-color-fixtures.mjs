// Shared SDR/HDR10/HLG patches plus a metadata-free PQ regression: a bright,
// uniform frame makes GPU automatic average-brightness scaling observable.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { pqCode } from './linux-color-reference.mjs'
import { inspectColorFixture } from './linux-color-fixture-validation.mjs'

const [binary, directory] = process.argv.slice(2)
assert(binary && directory, 'Usage: node scripts/playback-color-fixtures.mjs FFMPEG NEW_DIRECTORY')
const generated = spawnSync(process.execPath, [fileURLToPath(new URL('./linux-color-fixtures.mjs', import.meta.url)), binary, directory], { stdio: 'inherit' })
assert.equal(generated.status, 0, 'Shared color fixtures failed')
const manifestFile = path.join(directory, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestFile))
const { width, height } = manifest, code = Math.round(64 + 876 * pqCode(100)), raw = Buffer.alloc(width * height * 3)
for (let sample = 0; sample < width * height * 1.5; sample++) raw.writeUInt16LE(sample < width * height ? code : 512, sample * 2)
const input = path.join(directory, 'pq-no-metadata.yuv'), file = path.resolve(directory, 'pq-no-metadata.mkv')
fs.writeFileSync(input, raw)
const tags = ['-color_range', 'tv', '-color_trc', 'smpte2084', '-color_primaries', 'bt2020', '-colorspace', 'bt2020nc']
const args = ['-hide_banner', '-loglevel', 'error', '-stream_loop', '-1', '-f', 'rawvideo', '-pixel_format', 'yuv420p10le',
  '-video_size', `${width}x${height}`, '-framerate', '30', ...tags, '-i', input, '-t', '12', '-c:v', 'libx265', '-preset', 'ultrafast',
  '-x265-params', 'lossless=1:pools=2:frame-threads=1:log-level=error:range=limited:colorprim=9:transfer=16:colormatrix=9', ...tags, '-n', file]
const encoded = spawnSync(binary, args, { encoding: 'utf8', timeout: 120000 })
assert.equal(encoded.status, 0, encoded.stderr); fs.unlinkSync(input)
const fixture = { name: 'pq-no-metadata', file, trc: 'smpte2084', primaries: 'bt2020', range: 'limited',
  shape: 'uniform', sourcePeak: 10000, codes: Array(8).fill(code), args,
  sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
fixture.validation = inspectColorFixture(binary, fixture, width, height)
manifest.cases.push(fixture)
const probe = path.join(path.dirname(path.resolve(binary)), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
for (const item of manifest.cases.filter(f => f.trc === 'smpte2084')) {
  const result = spawnSync(probe, ['-v', 'error', '-show_frames', '-read_intervals', '%+#1', '-of', 'json', item.file], { encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, result.stderr)
  item.hdrSideData = JSON.parse(result.stdout).frames[0].side_data_list ?? []
  const mastering = item.hdrSideData.some(d => d.side_data_type === 'Mastering display metadata')
  const light = item.hdrSideData.some(d => d.side_data_type === 'Content light level metadata')
  assert.equal(mastering, item.name === 'hdr10'); assert.equal(light, item.name === 'hdr10')
}
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
