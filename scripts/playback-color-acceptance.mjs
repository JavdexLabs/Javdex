// Real cross-platform Canvas output; never imported into the application.
// Generate inputs with playback-color-fixtures.mjs; the color math is shared.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { bt2390Srgb, bt1886Srgb, pqLuminance, hlgLuminance } from './playback-hdr-reference.mjs'
import { createAcceptanceDirectory, seedAcceptanceCatalog, launchAcceptance, waitForState,
  waitForValue, closeAcceptance, output } from './playback-acceptance-support.mjs'
import { prepareNonRecordingPlayback } from './playback-acceptance-settings.mjs'

assert(['darwin', 'win32', 'linux'].includes(process.platform))
process.env.JAVDEX_PLAYBACK_DIAGNOSTICS = '1'
const [fixtureDirectory, mode = 'gpu'] = process.argv.slice(2)
assert(fixtureDirectory && ['gpu', 'cpu', 'recovery'].includes(mode),
  'Usage: node scripts/playback-color-acceptance.mjs FIXTURE_DIRECTORY gpu|cpu|recovery')
const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, 'manifest.json')))
assert.equal(manifest.cases.length, 5)
const fixtures = mode === 'recovery' ? manifest.cases.filter(f => f.name === 'hdr10')
  : process.argv.includes('--only-missing-metadata') ? manifest.cases.filter(f => f.name === 'pq-no-metadata') : manifest.cases
for (const fixture of fixtures) {
  assert.equal(fixture.validation?.passed, true)
  assert.equal(createHash('sha256').update(fs.readFileSync(fixture.file)).digest('hex'), fixture.sha256)
}
const directory = createAcceptanceDirectory('hdr-'), targets = seedAcceptanceCatalog(directory, fixtures.map(f => f.file))
const packaged = process.env.JAVDEX_PLAYBACK_ACCEPTANCE_EXECUTABLE
const resources = packaged ? process.platform === 'darwin' ? path.resolve(path.dirname(packaged), '../Resources') : path.join(path.dirname(path.resolve(packaged)), 'resources') : undefined
const nativeDirectory = process.platform === 'linux' ? resources
  ? path.join(resources, mode === 'cpu' ? 'linux-software-playback' : 'linux-texture-experimental')
  : mode === 'cpu' ? path.resolve('out/linux-software-runtime/linux-x64') : path.resolve('out/native-playback')
  : resources ? path.join(resources, 'native-playback') : path.resolve('out/native-playback')
const entry = process.platform === 'linux' ? mode === 'cpu' ? 'playback-software-helper' : 'playback-dmabuf-helper' : 'playback.node'
const library = fs.readdirSync(nativeDirectory).find(name => /^libmpv.*\.(?:dll|dylib|so(?:\.\d+)*)$/.test(name))
assert(library, 'missing libmpv identity for the tested host')
const report = { passed: false, platform: process.platform, mode, checks: [],
  nativeSha256: createHash('sha256').update(fs.readFileSync(path.join(nativeDirectory, entry))).digest('hex'),
  libmpvSha256: createHash('sha256').update(fs.readFileSync(path.join(nativeDirectory, library))).digest('hex'),
  fixtureManifestSha256: createHash('sha256').update(fs.readFileSync(path.join(fixtureDirectory, 'manifest.json'))).digest('hex'),
  limits: ['SDR compositor bytes only; no physical HDR output or display calibration',
    'GPU and CPU use the same static BT.2390 / 203 nit SDR reference'] }
const comparisonFile = process.argv.find(v => v.startsWith('--compare='))?.slice('--compare='.length)
const comparison = comparisonFile ? JSON.parse(fs.readFileSync(comparisonFile)) : undefined
if (comparison) assert(comparison.passed && comparison.fixtureManifestSha256 === report.fixtureManifestSha256, 'comparison must be a passed run of the same fixtures')
const save = () => fs.writeFileSync(path.join(output, `color-${mode}.json`), JSON.stringify(report, null, 2) + '\n')
let application
try {
  application = await launchAcceptance(directory, 'hdr-application.log', mode === 'cpu' ? ['--javdex-cpu'] : [])
  const page = await application.firstWindow()
  await page.waitForFunction(() => window.api?.playback && document.querySelector('nav'))
  await prepareNonRecordingPlayback(page)
  report.environment = await application.evaluate(async ({ app, screen }) => ({
    versions: process.versions, gpu: await app.getGPUInfo('complete'), displays: screen.getAllDisplays()
  }))
  const native = () => application.evaluate(() => {
    const request = {cpu: {alive: false, nativeFrames: 0, outstandingSurfaces: 0}, gpu: {alive: false, nativeFrames: 0, outstandingSurfaces: 0}}
    process.getBuiltinModule('diagnostics_channel').channel('javdex.playback.host.statistics').publish(request)
    return request
  })
  const capture = name => application.evaluate(async ({ BrowserWindow }, { output, name }) => {
    const window = BrowserWindow.getAllWindows()[0], image = await window.webContents.capturePage()
    const rect = await window.webContents.executeJavaScript(`(() => { const r = document.querySelector('canvas[data-playback-surface]').getBoundingClientRect(); const c=document.querySelector('canvas[data-playback-surface]'); return {x:r.x,y:r.y,width:r.width,height:r.height,viewport:innerWidth,intrinsicWidth:c.width,intrinsicHeight:c.height} })()`)
    const scale = image.getSize().width / rect.viewport
    const crop = image.crop({ x: Math.round(rect.x * scale), y: Math.round(rect.y * scale),
      width: Math.round(rect.width * scale), height: Math.round(rect.height * scale) })
    const { width, height } = crop.getSize(), bytes = crop.toBitmap()
    const contentScale = Math.min(width / 16, height / 9), ox = (width - 16 * contentScale) / 2, oy = (height - 9 * contentScale) / 2
    const rows = [.25, .75].map(v => Array.from({ length: 8 }, (_, index) => {
      const x = Math.floor(ox + 16 * contentScale * (index + .5) / 8), y = Math.floor(oy + 9 * contentScale * v), sum = [0, 0, 0]
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const at = ((y + dy) * width + x + dx) * 4
        for (let c = 0; c < 3; c++) sum[c] += bytes[at + 2 - c] / 25
      }
      return sum
    }))
    process.getBuiltinModule('fs').writeFileSync(process.getBuiltinModule('path').join(output, name + '.png'), crop.toPNG())
    return { width, height, intrinsicWidth: rect.intrinsicWidth, intrinsicHeight: rect.intrinsicHeight, gray: rows[0], colors: rows[1] }
  }, { output, name })
  for (const [index, fixture] of fixtures.entries()) {
    assert.equal((await page.evaluate(t => window.api.player.openResource(t.libraryId, t.resourceId, t.videoId), targets[index])).ok, true)
    let state = await waitForState(page, s => s?.phase === 'playing' && s.position > 1, 'HDR playback')
    assert.equal(state.info.playbackMode, mode === 'cpu' ? 'cpu' : 'gpu')
    const control = value => page.evaluate(({ id, value }) => window.api.playback.control(id, value), { id: state.sessionId, value })
    const check = { fixture: fixture.name, samples: [] }; report.checks.push(check)
    for (const phase of ['playing', 'paused', 'seek', 'docked', 'expanded', 'fullscreen', 'backward', 'resume']) {
      if (phase === 'paused') await control({ kind: 'pause', paused: true })
      if (phase === 'seek' || phase === 'backward') await control({ kind: 'seek', seconds: phase === 'seek' ? 4 : 1 })
      if (['docked', 'expanded', 'fullscreen'].includes(phase)) await control({ kind: 'presentation', value: phase })
      if (phase === 'resume') await control({ kind: 'pause', paused: false })
      if (phase === 'paused') await waitForState(page, s => s?.paused, 'HDR paused')
      if (phase === 'seek' || phase === 'backward') await waitForState(page, s => s?.paused && !s.seeking
        && Math.abs(s.position - (phase === 'seek' ? 4 : 1)) < .15, 'HDR paused seek')
      if (['docked', 'expanded', 'fullscreen'].includes(phase)) await waitForState(page, s => s?.presentation === phase, 'HDR presentation')
      if (phase === 'resume') await waitForState(page, s => s && !s.paused && s.position > 1.2, 'HDR resumed')
      await page.waitForTimeout(250)
      const sample = { phase, session: await page.evaluate(() => window.api.playback.snapshot()), hosts: await native(), ...await capture(`${mode}-${fixture.name}-${phase}`) }
      check.samples.push(sample); save()
      assert.equal(sample.session.info.playbackMode, mode === 'cpu' ? 'cpu' : 'gpu', 'every captured phase must retain the requested path')
      if (mode !== 'cpu') assert.equal(sample.session.info.playbackDiagnostics?.displayProbe, 'passed', 'captured GPU output must pass its display probe')
      for (const rgb of sample.gray) assert(Math.max(...rgb) - Math.min(...rgb) <= 3, 'neutral HDR/SDR gray acquired a tint')
      if (fixture.shape !== 'uniform') {
        assert(sample.gray[0].every(v => v <= 3), 'black level lifted')
        assert(sample.gray.at(-1).every(v => v >= 230), 'SDR peak is too dim')
        for (let n = 1; n < 8; n++) assert(sample.gray[n][0] > sample.gray[n - 1][0], 'gray steps collapsed')
      } else assert(sample.gray[0].every(v => v > 80 && v < 220), 'metadata-free PQ frame is blank or clipped')
      if (fixture.levels) {
        // Both paths explicitly convert BT.1886 video to the same sRGB target.
        check.expected = fixture.codes.map(c => {
          const code = fixture.range === 'full' ? c / 1023 : (c - 64) / 876
          return bt1886Srgb(code)
        })
      } else {
        const luminance = fixture.trc === 'smpte2084' ? pqLuminance : hlgLuminance
        check.expected = fixture.codes.map(c => bt2390Srgb(luminance((c - 64) / 876), fixture.sourcePeak ?? 1000))
      }
      if (check.expected) {
        const error = Math.max(...sample.gray.flatMap((rgb, i) => rgb.map(v => Math.abs(v - check.expected[i]))))
        check.maxReferenceError = Math.max(check.maxReferenceError ?? 0, error)
        assert(error <= 4, `SDR mapping differs from the luminance reference: ${error}`)
      }
      const drift = Math.max(...sample.gray.flatMap((rgb, i) => rgb.map((v, c) => Math.abs(v - check.samples[0].gray[i][c]))))
      if (comparison) {
        const reference = comparison.checks.find(c => c.fixture === fixture.name)?.samples.find(s => s.phase === phase)
        assert(reference, 'missing comparison phase')
        const difference = Math.max(...['gray', 'colors'].flatMap(key => sample[key].flatMap((rgb, i) => rgb.map((v, c) => Math.abs(v - reference[key][i][c])))))
        check.maxPathDifference = Math.max(check.maxPathDifference ?? 0, difference)
        assert(difference <= 4, `GPU/CPU color difference exceeds 4 bytes: ${difference}`)
      }
      check.maxPhaseDrift = Math.max(check.maxPhaseDrift ?? 0, drift)
      assert(drift <= 3, 'pause/seek/viewport changed the HDR brightness')
      for (let primary = 0; primary < (fixture.shape === 'uniform' ? 0 : 3); primary++) {
        const rgb = sample.colors[primary]
        assert(rgb[primary] > 70 && rgb[primary] > Math.max(...rgb.filter((_, c) => c !== primary)) + 50, 'primary hue lost')
      }
    }
    if (mode === 'recovery') {
      await control({ kind: 'pause', paused: true }); await control({ kind: 'seek', seconds: 4 })
      await control({ kind: 'volume', value: 31 }); await control({ kind: 'speed', value: 1.25 })
      await application.evaluate(() => { process.getBuiltinModule('diagnostics_channel').channel('javdex.playback.host.control').publish({mode: 'gpu', operation: 'kill'}) })
      await control({ kind: 'seek', seconds: 4.1 })
      state = await waitForState(page, s => s?.phase === 'paused' && s.info.playbackMode === 'cpu'
        && s.paused && !s.seeking && Math.abs(s.position - 4.1) < .3 && s.volume === 31 && s.speed === 1.25, 'HDR CPU recovery')
      assert.equal(state.info.playbackFallback, true); assert.equal(state.volume, 31); assert.equal(state.speed, 1.25)
      await waitForValue(native, s => s.cpu.nativeFrames > 0 && !s.gpu.alive, 'CPU HDR frame produced')
      await page.waitForTimeout(250)
      check.recovered = await capture('recovery-hdr10-cpu')
      assert(check.recovered.gray[0].every(v => v <= 3) && check.recovered.gray.at(-1).every(v => v >= 230))
      for (let n = 1; n < 8; n++) assert(check.recovered.gray[n][0] > check.recovered.gray[n - 1][0])
      await control({ kind: 'pause', paused: false }); await waitForState(page, s => s?.position > 4.8, 'CPU HDR clock progresses')
    }
    check.native = await native()
    assert.equal((mode === 'gpu' ? check.native.gpu : check.native.cpu).commandErrors, 0)
    await control({ kind: 'stop' }); await waitForState(page, s => s === null, 'HDR stop')
    check.stopped = await waitForValue(native, s => !s.cpu.alive && !s.gpu.alive && s.gpu.outstandingSurfaces === 0, 'HDR resources released')
    check.passed = true; save()
  }
  report.passed = true
} catch (error) { report.error = error.stack; process.exitCode = 1 }
finally {
  if (application) report.cleanup = await closeAcceptance(application)
  if (report.cleanup?.forced || report.cleanup?.code !== 0) { report.passed = false; process.exitCode = 1 }
  save()
}
console.log(JSON.stringify({ passed: report.passed, mode, checks: report.checks.map(c => ({ fixture: c.fixture,
  passed: c.passed, maxReferenceError: c.maxReferenceError, maxPhaseDrift: c.maxPhaseDrift })), error: report.error }))
