#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { extractFile, listPackage } from '@electron/asar'
import {
  MAC_ELECTRON_LANGUAGES,
  PORTABLE_ELECTRON_LANGUAGES,
  macElectronLocaleNames
} from './packaging-runtime.mjs'

const root = path.resolve(process.argv[2] ?? 'dist')

function findAsars(directory, depth = 0) {
  if (depth > 5 || !existsSync(directory)) return []
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isFile() && entry.name === 'app.asar') found.push(target)
    else if (entry.isDirectory()) found.push(...findAsars(target, depth + 1))
  }
  return found
}

function assertPackagedElectronLanguages(archive) {
  const resourcesDirectory = path.dirname(archive)
  const macFrameworkResources = path.resolve(
    resourcesDirectory,
    '..',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Resources'
  )
  if (existsSync(macFrameworkResources)) {
    const allowed = macElectronLocaleNames(MAC_ELECTRON_LANGUAGES)
    const locales = readdirSync(macFrameworkResources)
      .filter((entry) => entry.endsWith('.lproj'))
      .map((entry) => entry.slice(0, -'.lproj'.length))
    const unexpected = locales.filter((locale) => !allowed.has(locale))
    if (unexpected.length > 0) {
      throw new Error(`${archive} contains unexpected Electron locales: ${unexpected.join(', ')}`)
    }
    return
  }

  const portableLocales = path.resolve(resourcesDirectory, '..', 'locales')
  if (!existsSync(portableLocales)) return
  const allowed = new Set(PORTABLE_ELECTRON_LANGUAGES)
  const unexpected = readdirSync(portableLocales)
    .filter((entry) => entry.endsWith('.pak'))
    .map((entry) => entry.slice(0, -'.pak'.length))
    .filter((locale) => !allowed.has(locale))
  if (unexpected.length > 0) {
    throw new Error(`${archive} contains unexpected Electron locales: ${unexpected.join(', ')}`)
  }
}

const archives = findAsars(root)
if (archives.length === 0) {
  throw new Error(`No packaged app.asar found under ${root}`)
}

for (const archive of archives) {
  const entries = listPackage(archive).map((entry) => entry.replaceAll('\\', '/'))
  const required = [
    /^\/out\/main\/chunks\/piRuntime-.*\.js$/,
    /^\/out\/main\/chunks\/piSdk-.*\.js$/,
    /^\/out\/main\/chunks\/photon_rs_bg\.wasm$/,
    /^\/out\/renderer\/icon-192\.png$/,
    /^\/node_modules\/playwright-core\/package\.json$/,
    /^\/node_modules\/playwright-core\/lib\/coreBundle\.js$/,
    /^\/node_modules\/cheerio\/dist\/commonjs\/slim\.js$/
  ]
  for (const pattern of required) {
    if (!entries.some((entry) => pattern.test(entry))) {
      throw new Error(`${archive} is missing required Agent runtime entry ${pattern}`)
    }
  }
  const nonRuntime = entries.filter((entry) =>
    entry.startsWith('/node_modules/') &&
    (/\.d\.(?:ts|mts|cts)$/.test(entry) || entry.endsWith('.map'))
  )
  if (nonRuntime.length > 0) {
    throw new Error(`${archive} contains ${nonRuntime.length} type/source-map files`)
  }
  const rendererOnlyDependencies = [
    '@mediapipe/tasks-vision',
    '@tanstack/react-query',
    'lucide-react',
    'react-markdown'
  ]
  const packagedRendererDependencies = rendererOnlyDependencies.filter((dependency) =>
    entries.some((entry) => entry.startsWith(`/node_modules/${dependency}/`))
  )
  if (packagedRendererDependencies.length > 0) {
    throw new Error(
      `${archive} contains bundled renderer dependencies: ${packagedRendererDependencies.join(', ')}`
    )
  }
  const redundantRuntimeEntries = entries.filter(
    (entry) =>
      entry.startsWith('/out/resources/') ||
      entry.startsWith('/node_modules/@earendil-works/pi-coding-agent/') ||
      entry.startsWith('/node_modules/playwright-core/lib/vite/') ||
      entry.startsWith('/node_modules/undici/') ||
      entry.startsWith('/node_modules/parse5/') ||
      entry.startsWith('/node_modules/parse5-htmlparser2-tree-adapter/') ||
      entry.startsWith('/node_modules/parse5-parser-stream/') ||
      entry.startsWith('/node_modules/encoding-sniffer/') ||
      entry.startsWith('/node_modules/whatwg-mimetype/') ||
      /^\/out\/renderer\/icon-(?:16|32|48|512)\.png$/.test(entry) ||
      /^\/out\/renderer\/assets\/icon-.*\.png$/.test(entry)
  )
  if (redundantRuntimeEntries.length > 0) {
    throw new Error(`${archive} contains ${redundantRuntimeEntries.length} redundant runtime files`)
  }
  const playwrightPackage = JSON.parse(
    extractFile(archive, path.join('node_modules', 'playwright-core', 'package.json')).toString('utf8')
  )
  if (playwrightPackage.version !== '1.62.1') {
    throw new Error(`${archive} contains playwright-core ${playwrightPackage.version}, expected 1.62.1`)
  }
  const forbiddenBrowsers = entries.filter((entry) =>
    /\/node_modules\/(?:playwright\/|@playwright\/browser-)/.test(entry) ||
    /\/node_modules\/playwright-core\/(?:\.local-browsers|browser_patches)\//.test(entry) ||
    /\/(?:chromium|firefox|webkit)-\d+\//.test(entry)
  )
  if (forbiddenBrowsers.length > 0) {
    throw new Error(`${archive} contains ${forbiddenBrowsers.length} forbidden Playwright browser files`)
  }
  const sqlitePrebuilds = `${archive}.unpacked/node_modules/better-sqlite3/prebuilds`
  if (!existsSync(sqlitePrebuilds)) {
    throw new Error(`${archive} is missing unpacked better-sqlite3 prebuilds`)
  }
  const sqliteBinaries = readdirSync(sqlitePrebuilds).filter((entry) => entry.endsWith('.node'))
  if (sqliteBinaries.length < 1 || sqliteBinaries.length > 2) {
    throw new Error(
      `${archive} contains unexpected better-sqlite3 prebuilds: ${sqliteBinaries.join(', ')}`
    )
  }
  assertPackagedElectronLanguages(archive)
  const sizeMiB = (statSync(archive).size / 1024 / 1024).toFixed(1)
  console.log(`Packaged Agent runtime verified: ${archive} (${sizeMiB} MiB)`)
}
