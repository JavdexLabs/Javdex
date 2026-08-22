import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

export const MAC_ELECTRON_LANGUAGES = Object.freeze(['en', 'en_GB', 'zh_CN', 'zh_TW'])
export const PORTABLE_ELECTRON_LANGUAGES = Object.freeze(['en-US', 'en-GB', 'zh-CN', 'zh-TW'])

const BUILDER_ARCH_NAMES = Object.freeze(['ia32', 'x64', 'armv7l', 'arm64', 'universal'])
const MAC_LOCALE_VARIANTS = Object.freeze(['FEMININE', 'MASCULINE', 'NEUTER'])

function pythonSupportsNodeGyp(pythonPath) {
  return spawnSync(pythonPath, ['-c', 'import distutils'], {
    stdio: 'ignore',
    timeout: 5_000
  }).status === 0
}

/**
 * Modern Homebrew Python releases may omit distutils while the node-gyp bundled by Electron
 * still imports it. Respect an explicit caller choice, otherwise prefer Apple's compatible
 * Python on macOS so `npm run dist:mac` remains reproducible.
 */
export function resolveNodeGypPythonEnvironment(input = {}) {
  const platformName = input.platformName ?? process.platform
  const environment = input.environment ?? process.env
  if (environment.PYTHON || environment.npm_config_python || platformName !== 'darwin') return {}
  const canUse = input.canUse ?? pythonSupportsNodeGyp
  const pathExists = input.pathExists ?? existsSync
  const candidates = input.candidates ?? [
    '/usr/bin/python3',
    '/Library/Developer/CommandLineTools/usr/bin/python3'
  ]
  const selected = candidates.find((candidate) => pathExists(candidate) && canUse(candidate))
  return selected ? { PYTHON: selected, npm_config_python: selected } : {}
}

export function macElectronLocaleNames(languages = MAC_ELECTRON_LANGUAGES) {
  return new Set(
    languages.flatMap((language) => [
      language,
      ...MAC_LOCALE_VARIANTS.map((variant) => `${language}_${variant}`)
    ])
  )
}

export function mirrorDirectory(source, target) {
  rmSync(target, { recursive: true, force: true })
  if (!existsSync(source)) return
  mkdirSync(path.dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true })
}

export function electronBuilderArchName(arch) {
  const name = BUILDER_ARCH_NAMES[arch]
  if (!name) throw new Error(`Unsupported electron-builder arch: ${String(arch)}`)
  return name
}

export function expectedBetterSqlitePrebuilds(platformName, archName) {
  if (platformName === 'darwin' && archName === 'universal') {
    return new Set(['darwin-arm64.node', 'darwin-x64.node'])
  }
  if (!['darwin', 'linux', 'win32'].includes(platformName)) {
    throw new Error(`Unsupported better-sqlite3 packaging platform: ${platformName}`)
  }
  if (!['arm64', 'x64'].includes(archName)) {
    throw new Error(`Unsupported better-sqlite3 packaging arch: ${archName}`)
  }
  return new Set([`${platformName}-${archName}.node`])
}

export function pruneBetterSqlitePrebuilds(prebuildDirectory, platformName, archName) {
  if (!existsSync(prebuildDirectory)) {
    throw new Error(`Missing packaged better-sqlite3 prebuilds: ${prebuildDirectory}`)
  }
  const expected = expectedBetterSqlitePrebuilds(platformName, archName)
  const candidates = readdirSync(prebuildDirectory).filter((name) => name.endsWith('.node'))
  const missing = [...expected].filter((name) => !candidates.includes(name))
  if (missing.length > 0) {
    throw new Error(`Missing required better-sqlite3 prebuild: ${missing.join(', ')}`)
  }
  const removed = []
  for (const name of candidates) {
    if (expected.has(name)) continue
    rmSync(path.join(prebuildDirectory, name), { force: true })
    removed.push(name)
  }
  return { kept: [...expected].sort(), removed: removed.sort() }
}

export function pruneElectronFrameworkLocales(resourcesDirectory, languages = MAC_ELECTRON_LANGUAGES) {
  if (!existsSync(resourcesDirectory)) {
    throw new Error(`Missing Electron Framework resources: ${resourcesDirectory}`)
  }
  const allowed = macElectronLocaleNames(languages)
  const removed = []
  for (const name of readdirSync(resourcesDirectory)) {
    if (!name.endsWith('.lproj')) continue
    const locale = name.slice(0, -'.lproj'.length)
    if (allowed.has(locale)) continue
    rmSync(path.join(resourcesDirectory, name), { recursive: true, force: true })
    removed.push(name)
  }
  return removed.sort()
}

export function prunePackagedRuntime(context) {
  const platformName = context.electronPlatformName
  const archName = electronBuilderArchName(context.arch)
  const resourcesDirectory = context.packager.getResourcesDir(context.appOutDir)
  const sqlitePrebuilds = path.join(
    resourcesDirectory,
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
    'prebuilds'
  )
  const sqlite = pruneBetterSqlitePrebuilds(sqlitePrebuilds, platformName, archName)

  let removedLocales = []
  if (platformName === 'darwin') {
    const frameworkResources = path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
      'Resources'
    )
    removedLocales = pruneElectronFrameworkLocales(frameworkResources)
  }

  console.log(
    `Pruned packaged runtime (${platformName}/${archName}): ` +
    `${sqlite.removed.length} SQLite prebuilds, ${removedLocales.length} Electron locales`
  )
}
