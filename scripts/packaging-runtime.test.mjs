import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import buildConfig from '../electron-builder.config.mjs'
import {
  MAC_ELECTRON_LANGUAGES,
  expectedBetterSqlitePrebuilds,
  pruneBetterSqlitePrebuilds,
  pruneBetterSqliteBuildFiles,
  pruneElectronFrameworkLocales,
  resolveNodeGypPythonEnvironment
} from './packaging-runtime.mjs'

function tempDirectory(name) {
  return mkdtempSync(path.join(tmpdir(), `javdex-${name}-`))
}

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
