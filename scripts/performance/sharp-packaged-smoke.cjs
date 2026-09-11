// Run with ELECTRON_RUN_AS_NODE=1 <packaged executable> <this script> <app.asar> [output.json].
const { createRequire } = require('node:module')
const { join, sep } = require('node:path')
const { writeFileSync, realpathSync } = require('node:fs')
const assert = require('node:assert/strict')

async function main() {
  if (!process.argv[2]) throw new Error('Expected packaged app.asar path')
  const archive = realpathSync(process.argv[2])
  const packagedRequire = createRequire(join(archive, 'package.json'))
  const resolved = packagedRequire.resolve('sharp')
  assert.ok(resolved.startsWith(archive + sep), 'must load packaged Sharp, not workspace dependency')
  const sharp = packagedRequire('sharp')
  const formats = []
  for (const format of ['jpeg', 'png', 'webp', 'gif', 'avif']) {
    const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#804040' } })
      .toFormat(format).toBuffer()
    const metadata = await sharp(bytes).metadata()
    assert.equal(metadata.width, 12)
    assert.equal(metadata.height, 8)
    const thumbnail = await sharp(bytes, { limitInputPixels: 1024 }).resize(6, 4).png().toBuffer()
    assert.equal((await sharp(thumbnail).metadata()).width, 6)
    formats.push(format)
  }
  const report = { measuredAt: new Date().toISOString(), archive, resolved, platform: process.platform,
    arch: process.arch, electron: process.versions.electron, sharp: sharp.versions, formats }
  const json = JSON.stringify(report, null, 2) + '\n'
  if (process.argv[3]) writeFileSync(process.argv[3], json)
  process.stdout.write(json)
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
