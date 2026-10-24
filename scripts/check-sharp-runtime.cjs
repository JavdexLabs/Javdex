// Run with Node, Electron-as-Node, or the packaged executable as Node.
// Optional first argument: packaged resources/app.asar (module resolution root).
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const root = path.resolve(process.argv[2] || '.')
const requireRuntime = createRequire(path.join(root, 'package.json'))
const started = performance.now()
const sharp = requireRuntime('sharp')
const expectWasm = process.platform === 'linux' && Boolean(process.versions.electron)
assert.equal(Boolean(sharp.versions.emscripten), expectWasm, 'Unexpected Sharp backend')

async function main() {
  const formats = []
  for (const format of ['png', 'jpeg', 'webp', 'gif', 'avif']) {
    const buffer = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#58a0b5' } })
      .toFormat(format).toBuffer()
    const metadata = await sharp(buffer).metadata()
    assert.equal(metadata.width, 32)
    assert.equal(metadata.height, 16)
    const thumbnail = await sharp(buffer).resize(16, 16, { fit: 'inside' }).webp().toBuffer()
    const { data, info } = await sharp(thumbnail).raw().toBuffer({ resolveWithObject: true })
    assert.equal(info.width, 16)
    assert.equal(info.height, 8)
    assert.ok(data[0] > 50 && data[1] > 100 && data[2] > 120, 'Decoded image pixels are incorrect')
    formats.push(format)
  }
  const readyMs = performance.now() - started
  const source = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#58a0b5' } }).jpeg().toBuffer()
  const benchmarkStart = performance.now()
  for (let i = 0; i < 10; i++) await sharp(source).rotate().resize(320, 320, { fit: 'inside' }).webp({ quality: 82, effort: 3 }).toBuffer()
  if (expectWasm) assert.ok(!process.report.getReport().sharedObjects.some(file => /libvips/.test(file)), 'Native libvips loaded into Electron')
  console.log(JSON.stringify({ backend: expectWasm ? 'wasm' : 'native', formats, readyMs, thumbnailMeanMs: (performance.now() - benchmarkStart) / 10 }))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
