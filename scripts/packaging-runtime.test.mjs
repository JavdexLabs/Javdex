import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  MAC_ELECTRON_LANGUAGES,
  expectedBetterSqlitePrebuilds,
  mirrorDirectory,
  pruneBetterSqlitePrebuilds,
  pruneElectronFrameworkLocales,
  resolveNodeGypPythonEnvironment
} from './packaging-runtime.mjs'

function tempDirectory(name) {
  return mkdtempSync(path.join(tmpdir(), `javdex-${name}-`))
}

test('mirrorDirectory removes stale build resources before copying the source', (t) => {
  const root = tempDirectory('resources')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'source')
  const target = path.join(root, 'target')
  mkdirSync(source, { recursive: true })
  mkdirSync(path.join(target, 'stale'), { recursive: true })
  writeFileSync(path.join(source, 'icon.png'), 'current')
  writeFileSync(path.join(target, 'stale', 'old.png'), 'stale')

  mirrorDirectory(source, target)

  assert.equal(existsSync(path.join(target, 'stale', 'old.png')), false)
  assert.equal(existsSync(path.join(target, 'icon.png')), true)
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
