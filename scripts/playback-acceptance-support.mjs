// Test-only host. Never imported by the application or exposed through renderer IPC.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import electron from 'electron'
import { _electron } from 'playwright-core'

export const root = process.cwd()
export const output = path.join(root, 'out/playback-acceptance')
const acceptanceProcesses = new WeakMap()
export const acceptanceProcess = application => acceptanceProcesses.get(application) ?? application.process()

export function recordAcceptanceCleanup(report, cleanup) {
  report.cleanup = cleanup
  if (cleanup.forced || cleanup.code !== 0 || cleanup.signal !== null) {
    report.status = 'failed'
    report.error ??= 'acceptance host did not exit normally'
    process.exitCode = 1
  }
}

export function createAcceptanceDirectory(suffix = '') {
  assert.match(suffix, /^[a-z-]*$/)
  fs.mkdirSync(output, { recursive: true })
  return fs.mkdtempSync(path.join(os.tmpdir(), `javdex-playback-acceptance-${suffix}`))
}

export function seedAcceptanceCatalog(directory, media) {
  assert.ok(path.basename(directory).startsWith('javdex-playback-acceptance-'))
  const seeded = spawnSync(electron, ['--require', './scripts/register-test-paths.cjs', '--import', 'tsx',
    'scripts/playback-acceptance-seed.ts', ...media], {
    cwd: root, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', JAVDEX_TEST_USER_DATA: directory }
  })
  if (seeded.error) throw seeded.error
  assert.equal(seeded.status, 0, 'isolated acceptance catalog creation failed')
  return JSON.parse(fs.readFileSync(path.join(directory, 'targets.json'), 'utf8'))
}

export async function launchAcceptance(directory, logName = 'application.log', args = []) {
  assert.ok(['darwin', 'win32'].includes(process.platform), 'this acceptance host covers macOS and Windows only')
  assert.match(logName, /^[a-z-]+\.log$/)
  if (process.platform === 'win32') {
    const env = { ...process.env, JAVDEX_TEST_USER_DATA: directory }
    delete env.ELECTRON_RUN_AS_NODE
    const packaged = process.env.JAVDEX_PLAYBACK_ACCEPTANCE_EXECUTABLE
    let cwd = root
    if (packaged) {
      assert.ok(path.isAbsolute(packaged) && fs.statSync(packaged).isFile(), 'packaged acceptance executable must exist')
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'Path'
      env[pathKey] = path.join(process.env.SystemRoot, 'System32') + path.delimiter + process.env.SystemRoot
      delete env.JAVDEX_MPV_PREFIX
      cwd = path.join(directory, 'empty-cwd')
      fs.mkdirSync(cwd, { recursive: true })
    }
    const application = await _electron.launch({ executablePath: packaged ?? electron,
      args: packaged ? args : [root, ...args], cwd, env, timeout: 30000 })
    acceptanceProcesses.set(application, application.process())
    application.process().stderr.on('data', chunk => fs.appendFileSync(path.join(output, logName), chunk))
    return application
  }
  const bundle = path.join(output, 'Javdex Playback Acceptance.app')
  const original = path.resolve(path.dirname(electron), '../..')
  const originalPlist = fs.readFileSync(path.join(original, 'Contents/Info.plist'), 'utf8')
  const version = plist => /<key>CFBundleVersion<\/key>\s*<string>([^<]+)/.exec(plist)?.[1]
  if (fs.existsSync(bundle)) {
    assert.equal(version(fs.readFileSync(path.join(bundle, 'Contents/Info.plist'), 'utf8')), version(originalPlist),
      'acceptance Electron bundle is stale; preserve it elsewhere and rerun')
  } else {
    fs.cpSync(original, bundle, { recursive: true, verbatimSymlinks: true })
    fs.writeFileSync(path.join(bundle, 'Contents/Info.plist'), originalPlist
      .replace(/(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]+/, '$1com.javdex.playback-acceptance')
      .replace(/(<key>CFBundle(?:DisplayName|Name)<\/key>\s*<string>)[^<]+/g, '$1Javdex Playback Acceptance'))
  }
  const env = { ...process.env, JAVDEX_TEST_USER_DATA: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const application = await _electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/Electron'),
    args: [root, ...args], cwd: root, env, timeout: 30000 })
  acceptanceProcesses.set(application, application.process())
  application.process().stderr.on('data', chunk => fs.appendFileSync(path.join(output, logName), chunk))
  return application
}

export async function waitForValue(read, predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout
  let value
  do {
    value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw new Error(`${description}: ${JSON.stringify(value)}`)
}

export const waitForState = (page, predicate, description, timeout) =>
  waitForValue(() => page.evaluate(() => window.api.playback.snapshot()), predicate, description, timeout)

// Only observation: inspect() cannot consume the main session's events or actions.
// Keep diagnostics projected; raw tracks can contain local paths or signed locators.
export const nativeEvidence = application => application.evaluate(({ app }) => {
  const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
  const state = require(app.isPackaged ? process.resourcesPath + '/native-playback/playback.node' : app.getAppPath() + '/out/native-playback/playback.node').inspect()
  return { alive: state.alive, loadedFiles: state.loadedFiles, presentedFrames: state.presentedFrames,
    commandErrors: state.commandErrors, position: state['time-pos'], audioPosition: state['audio-pts'],
    audioTracks: JSON.parse(state['track-list'] ?? '[]').filter(track => track.type === 'audio').map(track => ({
      id: track.id, title: track.title, language: track.lang, codec: track.codec, channels: track['demux-channel-count']
    })) }
})

// One-shot render readback for acceptance only. Frames never cross product IPC.
export async function captureAcceptanceFrame(application, directory, name, { baseline = false, compare = false, whiteBounds = false } = {}) {
  assert.match(name, /^[a-z0-9-]+$/)
  const relative = path.relative(output, path.resolve(directory))
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), 'frame output must remain in ignored acceptance artifacts')
  return application.evaluate(({ app, nativeImage }, { directory, name, baseline, compare, whiteBounds }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const frame = require(app.isPackaged ? process.resourcesPath + '/native-playback/playback.node' : app.getAppPath() + '/out/native-playback/playback.node').capture()
    require('node:fs').writeFileSync(require('node:path').join(directory, name + '.png'),
      nativeImage.createFromBitmap(frame.data, { width: frame.width, height: frame.height }).toPNG())
    let visiblePixels = 0, differentPixels = 0, bottom = -1
    const differentQuadrants = { topLeft: 0, topRight: 0, bottomLeft: 0, bottomRight: 0 }
    const changedColors = { cyan: 0, magenta: 0, green: 0, yellow: 0, red: 0, white: 0 }
    let left = frame.width, top = frame.height, right = -1, whiteBottom = -1, whitePixels = 0
    const previous = globalThis.playbackAcceptanceBaseline
    if (compare && (!previous || previous.width !== frame.width || previous.height !== frame.height)) throw new Error('frame comparison geometry changed')
    for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
      const offset = (y * frame.width + x) * 4
      if ([0, 1, 2].some(channel => frame.data[offset + channel] > 30)) visiblePixels++
      if (compare && [0, 1, 2].some(channel => Math.abs(frame.data[offset + channel] - previous.data[offset + channel]) > 50)) {
        differentPixels++; bottom = y
        differentQuadrants[(y < frame.height / 2 ? 'top' : 'bottom') + (x < frame.width / 2 ? 'Left' : 'Right')]++
        const [blue, green, red] = frame.data.subarray(offset, offset + 3)
        if (blue > 180 && green > 180 && red < 80) changedColors.cyan++
        if (blue > 180 && red > 180 && green < 80) changedColors.magenta++
        if (green > 180 && blue < 80 && red < 80) changedColors.green++
        if (red > 180 && green > 180 && blue < 80) changedColors.yellow++
        if (red > 180 && green < 80 && blue < 80) changedColors.red++
        if (red > 180 && green > 180 && blue > 180) changedColors.white++
      }
      if (whiteBounds && [0, 1, 2].every(channel => frame.data[offset + channel] > 220)) {
        whitePixels++
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); whiteBottom = Math.max(whiteBottom, y)
      }
    }
    if (baseline) globalThis.playbackAcceptanceBaseline = frame
    if (compare) delete globalThis.playbackAcceptanceBaseline
    return { width: frame.width, height: frame.height, controlsTop: frame.controlsTop, visiblePixels, differentPixels, bottom,
      differentQuadrants, changedColors, whitePixels,
      whiteBounds: whiteBounds && right >= left ? { x: left, y: top, width: right - left + 1, height: whiteBottom - top + 1 } : null,
      sha256: require('node:crypto').createHash('sha256').update(frame.data).digest('hex') }
  }, { directory: path.resolve(directory), name, baseline, compare, whiteBounds })
}

export async function closeAcceptance(application) {
  const child = acceptanceProcess(application)
  const exited = () => child.exitCode != null || child.signalCode != null
  const exitWithin = ms => new Promise(resolve => {
    if (exited()) return resolve()
    const done = () => { clearTimeout(timer); child.off('exit', done); resolve() }
    const timer = setTimeout(done, ms)
    child.once('exit', done)
  })
  let forced = false
  // Keep the main inspector attached until async product disposal has settled.
  // Playwright close() detaches it immediately after app.quit().
  // A Windows modal dialog can keep quit/inspector evaluation pending. Wait on
  // the owned process instead so the timeout also covers that evaluation.
  void application.evaluate(({ app }) => app.quit()).catch(() => {})
  await exitWithin(8000)
  if (!exited()) {
    forced = true
    // Playwright's Windows launcher owns an Electron process tree. Killing only
    // the launcher can leave a modal browser process alive and close() waiting.
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    child.kill('SIGTERM')
    await exitWithin(2000)
    if (!exited()) {
      child.kill('SIGKILL')
      await waitForValue(exited, Boolean, 'owned acceptance process did not exit', 5000)
    }
  }
  await application.close().catch(() => {})
  return { forced, code: child.exitCode, signal: child.signalCode }
}
