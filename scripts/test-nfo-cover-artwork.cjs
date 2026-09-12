// Run in Electron (not ELECTRON_RUN_AS_NODE) to exercise the shipped native codec.
require('./register-test-paths.cjs')
require('tsx/cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, nativeImage } = require('electron')
app.setPath('userData', process.env.JAVDEX_TEST_USER_DATA)
app.disableHardwareAcceleration()
const { prepareCoverArtwork, renderCoverArtwork } = require('../apps/desktop/src/main/nfo/export/nfoCoverArtwork.ts')
const { NfoExportModule } = require('../apps/desktop/src/main/nfo/export/nfoExportModule.ts')
const { configureDesktopLibraryTestRuntime } = require('../apps/desktop/src/main/libraryRuntime.ts')
const { mediaAssetStore, readImageOrientationFromBuffer } = require('../packages/library/src/mediaAssetStore.ts')
const { encryptPlain } = require('../packages/library/src/assetCrypto.ts')

configureDesktopLibraryTestRuntime()

function bitmap(width, height) {
  const bytes = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      bytes[offset] = x % 251
      bytes[offset + 1] = y % 251
      bytes[offset + 2] = x < width / 2 ? 20 : 220
      bytes[offset + 3] = 255
    }
  }
  return nativeImage.createFromBitmap(bytes, { width, height })
}

function exif(orientation, little = true) {
  const data = Buffer.from(little
    ? '49492a0008000000010012010300010000000100000000000000'
    : '4d4d002a00000008000101120003000000010001000000000000', 'hex')
  if (little) data.writeUInt16LE(orientation, 18)
  else data.writeUInt16BE(orientation, 18)
  return data
}

function jpegExif(jpeg, orientation, little = true) {
  const metadata = Buffer.concat([Buffer.from('Exif\0\0'), exif(orientation, little)])
  const marker = Buffer.from([0xff, 0xe1, 0, 0])
  marker.writeUInt16BE(metadata.length + 2, 2)
  return Buffer.concat([jpeg.subarray(0, 2), marker, metadata, jpeg.subarray(2)])
}

async function run() {
  const source = bitmap(800, 538)
  for (const extension of ['.png', '.jpg']) {
    const bytes = extension === '.png' ? source.toPNG() : source.toJPEG(95)
    const variants = prepareCoverArtwork(bytes, extension)
    assert.deepEqual(variants.map(item => item.kind), ['cover', 'landscape'])
    assert.deepEqual(variants[0].recipe.crop, { x: 442, y: 0, width: 358, height: 537 })
    for (const item of variants) {
      const output = renderCoverArtwork(bytes, item.recipe)
      assert.equal(output.length, item.bytes)
      const decoded = nativeImage.createFromBuffer(output)
      assert.deepEqual(decoded.getSize(), item.kind === 'cover' ? { width: 358, height: 537 } : { width: 800, height: 538 })
      if (item.kind === 'landscape') assert.deepEqual(output, bytes)
      if (extension === '.png' && item.kind === 'cover') {
        assert.deepEqual(decoded.toBitmap(), source.crop(item.recipe.crop).toBitmap())
      }
    }
  }
  for (const [width, height] of [[70, 100], [40, 40]]) {
    const bytes = bitmap(width, height).toPNG()
    const variants = prepareCoverArtwork(bytes, '.png')
    assert.equal(variants.length, 1)
    assert.equal(Boolean(variants[0].warning), width === height)
    assert.deepEqual(renderCoverArtwork(bytes, variants[0].recipe), bytes)
  }

  // Corner labels A B / C D / E F, explicit expected arrangements for all eight orientations.
  const jpeg = bitmap(20, 30).toJPEG(95)
  const original = nativeImage.createFromBuffer(jpeg).toBitmap()
  const corners = [[0, 0], [19, 0], [0, 29], [19, 29]]
  const arrangements = [[0, 1, 2, 3], [1, 0, 3, 2], [3, 2, 1, 0], [2, 3, 0, 1], [0, 2, 1, 3], [2, 0, 3, 1], [3, 1, 2, 0], [1, 3, 0, 2]]
  for (let orientation = 1; orientation <= 8; orientation++) {
    const bytes = jpegExif(jpeg, orientation, orientation % 2 === 1)
    assert.equal(readImageOrientationFromBuffer(bytes), orientation)
    const variants = prepareCoverArtwork(bytes, '.jpg')
    assert.equal(variants.length, orientation >= 5 ? 2 : 1)
    const full = variants.find(item => item.kind === 'landscape') ?? variants[0]
    // PNG re-encoding lets us check exact oriented pixels without JPEG generation loss.
    const output = nativeImage.createFromBuffer(renderCoverArtwork(bytes, { ...full.recipe, encoding: 'png' }))
    const { width, height } = output.getSize()
    assert.deepEqual({ width, height }, orientation >= 5 ? { width: 30, height: 20 } : { width: 20, height: 30 })
    const pixels = output.toBitmap()
    const targetCorners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]
    targetCorners.forEach(([x, y], index) => {
      const [sx, sy] = corners[arrangements[orientation - 1][index]]
      assert.deepEqual(pixels.subarray((y * width + x) * 4, (y * width + x + 1) * 4), original.subarray((sy * 20 + sx) * 4, (sy * 20 + sx + 1) * 4), `orientation ${orientation}`)
    })
  }
  assert.throws(() => prepareCoverArtwork(Buffer.from('broken'), '.jpg'), /解码/)
  const tiny = bitmap(2, 1).toPNG()
  const tinyVariants = prepareCoverArtwork(tiny, '.png')
  assert.equal(tinyVariants[0].recipe, undefined)
  assert.deepEqual(renderCoverArtwork(tiny, tinyVariants[1].recipe), tiny)
  assert.throws(() => prepareCoverArtwork(Buffer.from('broken'), '.webp'), /解码/)
  const webp = Buffer.from('UklGRlYAAABXRUJQVlA4IEoAAAAwBACdASpQADIAPm02mUmkIyKhIagAgA2JaQB2APwAABtnvSQIECBAgJAA/vEKj//+hJ+CT8En5mf//ILlhdcUcPjoSuUIAAAAAA==', 'base64')
  // NativeImage only decodes JPEG/PNG on this runtime; reject unsupported codecs before writing.
  if (nativeImage.createFromBuffer(webp).isEmpty()) assert.throws(() => prepareCoverArtwork(webp, '.webp'), /解码/)
  else {
    const webpVariants = prepareCoverArtwork(webp, '.webp')
    assert.equal(webpVariants[0].extension, '.jpg')
    assert.equal(nativeImage.createFromBuffer(renderCoverArtwork(webp, webpVariants[0].recipe)).isEmpty(), false)
  }

  const rootPath = process.env.JAVDEX_TEST_USER_DATA
  const anchor = path.join(rootPath, 'TEST-001.mp4')
  fs.writeFileSync(anchor, 'video')
  const coverPath = 'covers/test.enc'
  const coverAbsolute = path.join(rootPath, 'media_assets', coverPath)
  fs.mkdirSync(path.dirname(coverAbsolute), { recursive: true })
  const coverBytes = source.toPNG()
  fs.writeFileSync(coverAbsolute, encryptPlain(coverBytes, '.png'))
  const snapshot = {
    resourceId: 1, libraryId: 1, libraryRevision: 1, videoId: 1, rootId: 1,
    root: { id: 1, libraryId: 1, path: rootPath, realPath: rootPath, state: 'active' },
    kind: 'local', anchorPath: anchor, code: 'TEST-001', coverPath,
    tags: [], actors: [], ratings: [], identities: [], samples: []
  }
  let snapshots = [snapshot]
  const module = new NfoExportModule({
    repository: { listResourceSnapshots: () => snapshots, getResourceSnapshot: () => snapshot },
    assetStore: mediaAssetStore, authorizeAnchor: () => snapshot.root, now: () => new Date()
  })
  const request = { libraryIds: [1], profileId: 'portable-v1', includeCover: true, includeFanart: false, includeSamples: false, includeActorAvatars: false, collisionPolicy: 'skip' }
  const apply = plan => module.apply(plan, 'test', { isTerminated: () => false }, () => {})
  const plan = await module.plan(request)
  assert.equal(Object.isFrozen(plan.files.find(file => file.kind === 'cover').content.artwork.crop), true)
  assert.equal(plan.preview.summary.fileCount, 3)
  const initialReport = await apply(plan)
  assert.equal(initialReport.writtenCount, 3, JSON.stringify(initialReport.items))
  const outputs = ['TEST-001.nfo', 'TEST-001-poster.png', 'TEST-001-landscape.png']
  assert.equal(outputs.reduce((total, name) => total + fs.statSync(path.join(rootPath, name)).size, 0), plan.preview.summary.estimatedBytes)
  assert.match(fs.readFileSync(path.join(rootPath, outputs[0]), 'utf8'), /aspect="landscape">TEST-001-landscape.png/)
  assert.deepEqual(fs.readFileSync(path.join(rootPath, outputs[2])), coverBytes)
  assert.equal((await module.plan(request)).preview.summary.skipCount, 3)
  const replace = await module.plan({ ...request, collisionPolicy: 'replace' })
  assert.equal(replace.preview.summary.replaceCount, 3)
  assert.equal((await apply(replace)).writtenCount, 3)
  fs.writeFileSync(path.join(rootPath, 'TEST-001-poster.jpg'), 'old image')
  assert.ok((await module.plan(request)).preview.warnings.some(warning => warning.includes('其他扩展名')))
  const otherAnchor = path.join(rootPath, 'TEST-001-landscape.mp4')
  fs.writeFileSync(otherAnchor, 'video')
  snapshots = [snapshot, { ...snapshot, resourceId: 2, anchorPath: otherAnchor }]
  const collision = await module.plan({ ...request, profileId: 'infuse-current' })
  assert.equal(collision.files.find(file => file.targetPath === path.join(rootPath, 'TEST-001-landscape.png')).action, 'conflict')
  const otherNfo = collision.files.find(file => file.targetPath === path.join(rootPath, 'TEST-001-landscape.nfo'))
  assert.doesNotMatch(otherNfo.content.bytes.toString(), /aspect="poster"/)
  snapshots = [snapshot]
  const stale = await module.plan({ ...request, collisionPolicy: 'replace' })
  fs.writeFileSync(coverAbsolute, encryptPlain(bitmap(60, 40).toPNG(), '.png'))
  const report = await apply(stale)
  assert.equal(report.items.filter(item => item.disposition === 'stale-plan').length, 2)
  console.log('NFO_NATIVE_ARTWORK_OK')
}

run().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
