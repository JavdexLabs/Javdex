import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FileMatcher, getMainFileMatchers } from 'app-builder-lib/out/fileMatcher.js'
import { doMergeConfigs } from 'app-builder-lib/out/util/config/config.js'
import buildConfig from '../electron-builder.config.mjs'
import { createPackageWithOptions, extractAll } from '@electron/asar'
import { verifyAsarUnpackedFiles } from './packaged-asar.mjs'
import {
  MAC_ELECTRON_LANGUAGES,
  expectedBetterSqlitePrebuilds,
  isPackagedExecutableHostCompatible,
  pruneBetterSqlitePrebuilds,
  pruneBetterSqliteBuildFiles,
  pruneElectronFrameworkLocales,
  resolveNodeGypPythonEnvironment
} from './packaging-runtime.mjs'

function tempDirectory(name) {
  return mkdtempSync(path.join(tmpdir(), `javdex-${name}-`))
}

test('SQLite packaging excludes removed files before generating the archive index', () => {
  const root = process.cwd(), config = buildConfig()
  for (const [platform, arch, kept] of [['linux', 'x64', ['linux-x64']], ['win', 'arm64', ['win32-arm64']],
    ['mac', 'universal', ['darwin-arm64', 'darwin-x64']]]) {
    const filter = new FileMatcher(root, '/unused-package-output', value => value.replaceAll('${arch}', arch),
      ['node_modules/**/*', ...config.files, ...config[platform].files]).createFilter()
    const selected = name => filter(path.join(root, 'node_modules/better-sqlite3', name), { isDirectory: () => false })
    for (const name of ['lib/index.js', 'package.json', 'LICENSE']) assert.equal(selected(name), true)
    for (const name of ['binding.gyp', 'build/Makefile', 'deps/common.gypi', 'src/better_sqlite3.cpp']) assert.equal(selected(name), false)
    for (const target of ['linux-x64', 'linux-arm64', 'linuxmusl-x64', 'darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64']) {
      assert.equal(selected(`prebuilds/${target}.node`), kept.includes(target), `${platform}/${arch}: ${target}`)
    }
  }
})

test('archive verification accepts internal aliases but rejects missing unpacked files', async t => {
  const root = tempDirectory('asar-index')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const input = path.join(root, 'input'), archive = path.join(root, 'app.asar')
  mkdirSync(input); writeFileSync(path.join(input, 'binding.node'), 'fixture')
  // Windows symlink creation needs privileges unrelated to this archive check.
  if (process.platform !== 'win32') symlinkSync('binding.node', path.join(input, 'alias.js'))
  await createPackageWithOptions(input, archive, { unpack: '*.node' })
  verifyAsarUnpackedFiles(archive)
  extractAll(archive, path.join(root, 'extracted'))
  rmSync(path.join(archive + '.unpacked', 'binding.node'))
  assert.throws(() => verifyAsarUnpackedFiles(archive), /Missing ASAR unpacked file: binding.node/)
})

test('pruneBetterSqlitePrebuilds retains only the current platform and arch', (t) => {
  const root = tempDirectory('sqlite')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const name of [
    'darwin-arm64.node',
    'darwin-x64.node',
    'linux-x64.node',
    'linuxmusl-x64.node',
    'win32-x64.node'
  ]) {
    writeFileSync(path.join(root, name), name)
  }

  const result = pruneBetterSqlitePrebuilds(root, 'darwin', 'arm64')

  assert.deepEqual(result.kept, ['darwin-arm64.node'])
  assert.deepEqual(readdirSync(root), ['darwin-arm64.node'])
})

test('pruneBetterSqliteBuildFiles removes sources but preserves runtime files', (t) => {
  const root = tempDirectory('sqlite-build-files')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const name of ['build', 'deps', 'lib', 'prebuilds', 'src']) {
    mkdirSync(path.join(root, name))
    writeFileSync(path.join(root, name, 'file'), name)
  }
  writeFileSync(path.join(root, 'binding.gyp'), 'build config')
  writeFileSync(path.join(root, 'package.json'), '{}')

  assert.deepEqual(pruneBetterSqliteBuildFiles(root), ['binding.gyp', 'build', 'deps', 'src'])
  assert.deepEqual(readdirSync(root).sort(), ['lib', 'package.json', 'prebuilds'])
})

test('better-sqlite3 prebuild selection covers every configured packaging platform', () => {
  assert.deepEqual([...expectedBetterSqlitePrebuilds('win32', 'x64')], ['win32-x64.node'])
  assert.deepEqual([...expectedBetterSqlitePrebuilds('linux', 'x64')], ['linux-x64.node'])
  assert.deepEqual(
    [...expectedBetterSqlitePrebuilds('darwin', 'universal')].sort(),
    ['darwin-arm64.node', 'darwin-x64.node']
  )
})

test('pruneElectronFrameworkLocales keeps English and Chinese locale variants', (t) => {
  const root = tempDirectory('locales')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const locale of [
    'en',
    'en_FEMININE',
    'en_GB',
    'zh_CN',
    'zh_TW_NEUTER',
    'de',
    'ja'
  ]) {
    const directory = path.join(root, `${locale}.lproj`)
    mkdirSync(directory)
    writeFileSync(path.join(directory, 'locale.pak'), locale)
  }

  pruneElectronFrameworkLocales(root, MAC_ELECTRON_LANGUAGES)

  assert.deepEqual(readdirSync(root).sort(), [
    'en.lproj',
    'en_FEMININE.lproj',
    'en_GB.lproj',
    'zh_CN.lproj',
    'zh_TW_NEUTER.lproj'
  ])
})

test('mac packaging selects a node-gyp compatible Python unless the caller chose one', () => {
  const selected = resolveNodeGypPythonEnvironment({
    platformName: 'darwin',
    environment: {},
    candidates: ['/python/new', '/python/compatible'],
    pathExists: () => true,
    canUse: (candidate) => candidate === '/python/compatible'
  })
  assert.deepEqual(selected, {
    PYTHON: '/python/compatible',
    npm_config_python: '/python/compatible'
  })
  assert.deepEqual(resolveNodeGypPythonEnvironment({
    platformName: 'darwin',
    environment: { PYTHON: '/python/explicit' },
    canUse: () => true
  }), {})
  assert.deepEqual(resolveNodeGypPythonEnvironment({
    platformName: 'linux',
    environment: {},
    canUse: () => true
  }), {})
})

test('packaged runtime smoke runs only for a host-compatible macOS executable', () => {
  const inspect = () => ({ status: 0, stdout: 'x86_64 arm64\n' })
  assert.equal(isPackagedExecutableHostCompatible('/app', {
    platformName: 'darwin', hostArch: 'arm64', inspect
  }), true)
  assert.equal(isPackagedExecutableHostCompatible('/app', {
    platformName: 'darwin', hostArch: 'x64', inspect
  }), true)
  assert.equal(isPackagedExecutableHostCompatible('/app', {
    platformName: 'darwin', hostArch: 'arm64',
    inspect: () => ({ status: 0, stdout: 'x86_64\n' })
  }), false)
  assert.equal(isPackagedExecutableHostCompatible('/app', {
    platformName: 'linux', hostArch: 'arm64',
    inspect: () => { throw new Error('must not inspect non-macOS executables') }
  }), true)
  assert.throws(() => isPackagedExecutableHostCompatible('/app', {
    platformName: 'darwin', hostArch: 'arm64',
    inspect: () => ({ status: 1, stdout: '', stderr: 'bad binary' })
  }), /bad binary/)
})

test('packaging retains the complete Cheerio runtime dependency chain', () => {
  const files = buildConfig().files.map(String)
  const requiredRuntimeDependencies = [
    'cheerio',
    'undici',
    'parse5',
    'parse5-htmlparser2-tree-adapter',
    'parse5-parser-stream',
    'encoding-sniffer',
    'whatwg-mimetype'
  ]

  for (const dependency of requiredRuntimeDependencies) {
    assert.equal(
      files.some((entry) => entry === `!node_modules/${dependency}/**/*`),
      false,
      `${dependency} must remain available to packaged worker-thread module resolution`
    )
  }
})

test('mac packaging explicitly enables ad-hoc signing before invoking its custom signer', () => {
  const mac = buildConfig().mac
  assert.equal(mac.identity, '-')
  assert.equal(typeof mac.sign, 'function')
})

test('Windows packaging retains host native modules and removes foreign platforms and architectures', () => {
  const root = process.cwd()
  for (const arch of ['x64', 'arm64']) {
    const config = buildConfig()
    // Dependencies are included by electron-builder's separate node-module file
    // set. Model that inclusion before applying the application's exclusions.
    const patterns = ['node_modules/**/*', ...config.files, ...config.win.files]
    const filter = new FileMatcher(root, '/unused-package-output', value => value.replaceAll('${arch}', arch), patterns).createFilter()
    const selected = file => filter(path.join(root, file), { isDirectory: () => false })
    const otherArch = arch === 'x64' ? 'arm64' : 'x64'
    for (const file of [
      `node_modules/@mariozechner/clipboard-win32-${arch}-msvc/clipboard.node`,
      `node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-${arch}/console.node`,
      'node_modules/@mariozechner/clipboard/index.js'
    ]) assert.equal(selected(file), true, `${arch} requires ${file}`)
    for (const file of [
      `node_modules/@mariozechner/clipboard-win32-${otherArch}-msvc/clipboard.node`,
      'node_modules/@mariozechner/clipboard-darwin-universal/clipboard.node',
      'node_modules/@mariozechner/clipboard-linux-x64-gnu/clipboard.node',
      'node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-arm64/modifiers.node',
      `node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-${otherArch}/console.node`
    ]) assert.equal(selected(file), false, `${arch} must exclude ${file}`)
  }
})

test('desktop packaging keeps bundled Photon WASM and LAN web while excluding their redundant copies', () => {
  const root = process.cwd()
  const filter = new FileMatcher(root, '/unused-package-output', value => value, ['node_modules/**/*', ...buildConfig().files]).createFilter()
  const selected = file => filter(path.join(root, file), { isDirectory: () => false })
  for (const file of ['out/main/chunks/photon_rs_bg.wasm', 'out/web/index.html', 'node_modules/@silvia-odwyer/photon-node/LICENSE.md']) {
    assert.equal(selected(file), true, `${file} is required at runtime or for notices`)
  }
  for (const file of ['out/server/index.js', 'out/server/web/index.html', 'out/updater/index.js', 'out/server-single-container-unit.log', 'out/server-update-ui/light-1440.png', 'node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm']) {
    assert.equal(selected(file), false, `${file} is a redundant desktop input`)
  }
})

for (const platform of ['win', 'mac', 'linux']) test(`normalized ${platform} desktop matchers do not default to including the repository`, () => {
  const root = process.cwd()
  const config = doMergeConfigs([buildConfig()])
  const debugLogger = { isEnabled: false }
  const packager = { config, projectDir: root, buildResourcesDir: 'build', debugLogger }
  const matchers = getMainFileMatchers(root, '/unused-package-output', value => value.replaceAll('${arch}', 'x64'),
    config[platform], { info: packager, config, debugLogger }, path.join(root, 'dist'), false)
  const selected = file => matchers.some(matcher => matcher.createFilter()(path.join(root, file), { isDirectory: () => false }))
  for (const file of ['out/playback-acceptance/build/large.dll', 'out/server/index.js', 'scripts/dist.mjs', 'docs/DEVELOPMENT.md']) {
    assert.equal(selected(file), false, `${file} must be excluded by every app file set`)
  }
  for (const file of ['out/main/index.js', 'out/web/index.html', 'out/main/chunks/photon_rs_bg.wasm']) {
    assert.equal(selected(file), true, `${file} must remain in the application`)
  }
})

test('desktop Sharp packaging keeps WASM for Linux and native image libraries for Windows and macOS', () => {
  const root = process.cwd(), config = buildConfig()
  for (const platform of ['win', 'mac', 'linux']) {
    const filter = new FileMatcher(root, '/unused-package-output', value => value.replaceAll('${arch}', 'x64'),
      ['node_modules/**/*', ...config.files, ...config[platform].files]).createFilter()
    const selected = file => filter(path.join(root, file), { isDirectory: () => false })
    for (const file of ['node_modules/@img/sharp-wasm32/package.json', 'node_modules/@img/sharp-wasm32/lib/sharp-wasm32-0.35.5.node.wasm'])
      assert.equal(selected(file), platform === 'linux', `${platform}: ${file}`)
    assert.equal(selected('node_modules/sharp/dist/sharp.cjs'), true, `${platform} requires the Sharp loader`)
    const native = platform === 'win' ? 'win32-x64' : platform === 'mac' ? 'darwin-x64' : 'linux-x64'
    assert.equal(selected(`node_modules/@img/sharp-${native}/lib/sharp.node`), true, `${platform} requires its native backend`)
    if (platform === 'win') assert.equal(selected(`node_modules/@img/sharp-${native}/lib/libvips-42.dll`), true)
  }
})

test('desktop packages retain the current license, historical MIT notice and third-party notices', () => {
  const root = process.cwd()
  const filter = new FileMatcher(root, '/unused-package-output', value => value, buildConfig().files).createFilter()
  for (const file of ['LICENSE', 'NOTICE', 'LICENSES/Javdex-MIT.txt', 'LICENSES/node-gyp-MIT.txt', 'docs/THIRD_PARTY_NOTICES.md']) {
    assert.equal(filter(path.join(root, file), { isDirectory: () => false }), true, `${file} must remain in the application archive`)
  }
})

test('desktop packages exclude playback acceptance fixtures and development native binaries', () => {
  const root = process.cwd()
  const filter = new FileMatcher(root, '/unused-package-output', value => value, buildConfig().files).createFilter()
  const selected = file => filter(path.join(root, file), { isDirectory: () => false })
  for (const file of [
    'out/playback-acceptance/media-matrix/hevc-main10.mkv',
    'out/playback-acceptance/Javdex Playback Acceptance.app/Contents/MacOS/Electron',
    'out/playback-acceptance/Javdex Playback Acceptance-43.8.0.app/Contents/MacOS/Electron',
    'out/linux-renderer-check/debug-linux-surface.cjs',
    'out/libmpv-prototype/playback.node',
    'out/libmpv-prototype/smoke-report.json',
    'out/native-playback/playback.node',
    'out/native-playback/navigation-key-test',
    'out/playback-runtime/darwin-arm64/playback.node'
  ]) assert.equal(selected(file), false, `${file} is a development artifact, not an audited packaged runtime`)
  for (const file of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
    assert.equal(selected(file), true, `${file} remains in the application archive`)
  }
})

test('Linux glibc packaging excludes foreign binaries but retains native loaders and notices', () => {
  const root = process.cwd()
  for (const arch of ['x64', 'arm64']) {
    const config = buildConfig()
    const filter = new FileMatcher(root, '/unused-package-output', value => value.replaceAll('${arch}', arch),
      ['node_modules/**/*', ...config.files, ...config.linux.files]).createFilter()
    const selected = file => filter(path.join(root, file), { isDirectory: () => false })
    for (const file of [
      `node_modules/@img/sharp-linux-${arch}/lib/sharp.node`,
      `node_modules/@img/sharp-libvips-linux-${arch}/lib/libvips-cpp.so.8`,
      `node_modules/@mariozechner/clipboard-linux-${arch}-gnu/clipboard.node`,
      'node_modules/@mariozechner/clipboard/index.js',
      'node_modules/sharp/dist/sharp.cjs',
      'node_modules/@img/colour/index.cjs',
      'node_modules/@img/sharp-wasm32/index.cjs',
      'node_modules/@img/sharp-wasm32/lib/sharp-wasm32-0.35.5.node.js',
      'node_modules/@img/sharp-wasm32/lib/sharp-wasm32-0.35.5.node.wasm',
      'node_modules/@emnapi/runtime/dist/index.js',
      'node_modules/@img/sharp-linuxmusl-x64/LICENSE',
      'node_modules/@img/sharp-libvips-linuxmusl-x64/package.json',
      'node_modules/@mariozechner/clipboard-darwin-arm64/LICENSE'
    ]) assert.equal(selected(file), true, `${arch} must retain ${file}`)
    const otherArch = arch === 'x64' ? 'arm64' : 'x64'
    for (const file of [
      `node_modules/@img/sharp-linux-${otherArch}/lib/sharp.node`,
      `node_modules/@img/sharp-libvips-linux-${otherArch}/lib/libvips-cpp.so.8`,
      'node_modules/@img/sharp-linuxmusl-x64/lib/sharp.node',
      'node_modules/@img/sharp-libvips-linuxmusl-x64/lib/libvips-cpp.so.8.18.7',
      `node_modules/@mariozechner/clipboard-linux-${otherArch}-gnu/clipboard.node`,
      'node_modules/@mariozechner/clipboard-linux-x64-musl/clipboard.node',
      'node_modules/@mariozechner/clipboard-win32-x64-msvc/clipboard.node',
      'node_modules/@mariozechner/clipboard-darwin-universal/clipboard.node',
      'node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-arm64/modifiers.node'
    ]) assert.equal(selected(file), false, `${arch} must exclude ${file}`)
  }
})
