import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

function sourceFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(fullPath)
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [fullPath] : []
  })
}

function importsOfSource(source) {
  const specifiers = new Set()
  for (const match of source.matchAll(/\bimport\s+(?:[^'";]*?\s+from\s+)?(['"])([^'"]+)\1/g)) {
    specifiers.add(match[2])
  }
  for (const match of source.matchAll(/\bexport\s+(?:\*|\{[^}]*\})\s+from\s+(['"])([^'"]+)\1/g)) {
    specifiers.add(match[2])
  }
  for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    specifiers.add(match[2])
  }
  return [...specifiers]
}

function importsOf(file) {
  return importsOfSource(readFileSync(file, 'utf8'))
}

const parserProbe = importsOfSource(`
  import value from '../main/default'
  import { named } from '../main/named'
  import '../main/side-effect'
  const lazy = import('../main/dynamic')
  const legacy = require('../main/commonjs')
  export { named } from '../main/re-export'
  export * from '../main/export-all'
`)
for (const expected of [
  'default',
  'named',
  'side-effect',
  'dynamic',
  'commonjs',
  're-export',
  'export-all'
]) {
  if (!parserProbe.some((specifier) => specifier.endsWith(expected))) {
    throw new Error(`Dependency import parser missed ${expected} import syntax`)
  }
}

const violations = []
const channelSource = readFileSync('packages/contracts/src/ipc-channels.ts', 'utf8')
const contractFiles = [
  'packages/contracts/src/actressIpcContract.ts',
  'packages/contracts/src/videoIpcContract.ts',
  'packages/contracts/src/scrapeIpcContract.ts',
  'packages/contracts/src/mediaLibraryIpcContract.ts',
  'packages/contracts/src/nfoExportIpcContract.ts',
  'packages/contracts/src/appIpcContract.ts'
]
const contractSources = contractFiles.map((file) => readFileSync(file, 'utf8'))
const channels = [...channelSource.matchAll(/^\s{2}([A-Z0-9_]+):/gm)].map((match) => match[1])
for (const channel of channels) {
  const owners = contractFiles.filter((_, index) =>
    contractSources[index].includes(`[IPC.${channel}]`)
  )
  if (owners.length === 0) {
    violations.push(`packages/contracts/src/ipc-channels.ts: IPC.${channel} has no command or event contract`)
  } else if (owners.length > 1) {
    violations.push(`packages/contracts/src/ipc-channels.ts: IPC.${channel} belongs to multiple contracts: ${owners.join(', ')}`)
  }
}

const retiredAggregate = path.resolve('packages/contracts/src/types.ts')
if (existsSync(retiredAggregate)) {
  violations.push('packages/contracts/src/types.ts: retired aggregate type entry must not be restored')
}
for (const root of ['src', 'scripts']) {
  for (const file of sourceFiles(root)) {
    for (const specifier of importsOf(file)) {
      const resolved = specifier === '@shared/types'
        ? retiredAggregate
        : specifier.startsWith('.')
          ? path.resolve(path.dirname(file), `${specifier}.ts`)
          : null
      if (resolved === retiredAggregate) {
        violations.push(`${file}: import types from the owning shared domain module, not ${specifier}`)
      }
    }
  }
}

for (const file of sourceFiles('apps/desktop/src/main/ipc')) {
  if (['apps/desktop/src/main/ipc/shared.ts', 'apps/desktop/src/main/ipc/typedIpcAdapter.ts'].includes(file.replaceAll('\\', '/'))) {
    continue
  }
  const source = readFileSync(file, 'utf8')
  if (/\bregisterHandler\b/.test(source)) {
    violations.push(`${file}: IPC handlers must register through a typed contract adapter`)
  }
  if (/webContents(?:\.|\?\.)send\s*\(/.test(source)) {
    violations.push(`${file}: IPC events must send through a typed event adapter`)
  }
}

const preloadSource = readFileSync('apps/desktop/src/preload/index.ts', 'utf8')
const preloadApiSource = preloadSource.slice(preloadSource.indexOf('const api ='))
if (/\binvoke\s*</.test(preloadApiSource)) {
  violations.push('apps/desktop/src/preload/index.ts: exposed APIs must invoke through a typed domain helper')
}
if (/ipcRenderer\.on\s*\(\s*IPC\./.test(preloadApiSource)) {
  violations.push('apps/desktop/src/preload/index.ts: exposed event APIs must subscribe through a typed domain helper')
}

for (const file of sourceFiles('apps/desktop/src/renderer/src')) {
  for (const specifier of importsOf(file)) {
    if (/(^|\/)main(\/|$)/.test(specifier) || specifier.startsWith('@main/')) {
      violations.push(`${file}: renderer must not import main-process module ${specifier}`)
    }
  }
}

const actressHandler = 'apps/desktop/src/main/ipc/actressHandlers.ts'
const actressApplicationSeams = new Set([
  '../services/actressQueryService',
  '../services/actressMaintenanceService',
  '../services/actressIdentityConflictWorkflow'
])
for (const specifier of importsOf(actressHandler)) {
  if (
    /\.\.\/(db|scrapers)\//.test(specifier) ||
    (/\.\.\/services\//.test(specifier) && !actressApplicationSeams.has(specifier))
  ) {
    violations.push(
      `${actressHandler}: actress IPC must delegate through query / maintenance / identity seams`
    )
  }
}

const videoApplicationSeams = new Set([
  '../services/videoQueryService',
  '../services/videoMaintenanceService',
  '../services/videoLifecycleService'
])

const videoHandler = 'apps/desktop/src/main/ipc/videoHandlers.ts'
for (const specifier of importsOf(videoHandler)) {
  if (
    /\.\.\/(db|scrapers)\//.test(specifier) ||
    (/\.\.\/services\//.test(specifier) && !videoApplicationSeams.has(specifier))
  ) {
    violations.push(
      `${videoHandler}: video IPC must delegate through query / maintenance seams`
    )
  }
}

const classificationHandler = 'apps/desktop/src/main/ipc/facetHandlers.ts'
const classificationApplicationSeams = new Set([
  '../services/tagQueryService',
  '../services/catalogReadService',
  '../services/classificationQueryService',
  '../services/classificationMaintenanceService',
  '../services/classificationImageService',
  '../services/directorMergeService',
  '../services/seriesMergeService',
  '../services/organizationMergeService',
  '../services/classificationDeletionService',
  '../services/organizationDeletionService'
])
for (const specifier of importsOf(classificationHandler)) {
  if (
    /\.\.\/(db|scrapers)\//.test(specifier) ||
    (/\.\.\/services\//.test(specifier) && !classificationApplicationSeams.has(specifier))
  ) {
    violations.push(
      `${classificationHandler}: classification IPC must delegate through approved application seams`
    )
  }
}

const scrapeHandler = 'apps/desktop/src/main/ipc/scrapeHandlers.ts'
for (const specifier of importsOf(scrapeHandler)) {
  if (
    /\.\.\/(db|scrapers)\//.test(specifier) ||
    (/\.\.\/services\//.test(specifier) &&
      ![
        '../services/scrapeJobController',
        '../services/scraperPluginCatalog',
        '../services/scraperServiceConfiguration'
      ].includes(specifier))
  ) {
    violations.push(`${scrapeHandler}: scrape IPC must delegate through its application modules`)
  }
}

function isForbiddenDatabaseImport(specifier) {
  return (
    /\.\.\/(services|ipc|scrapers)\//.test(specifier) ||
    specifier === 'electron' ||
    /^(?:node:)?(?:fs|path)(?:\/|$)/.test(specifier)
  )
}

for (const probe of ['node:fs', 'node:fs/promises', 'node:path', 'node:path/posix']) {
  if (!isForbiddenDatabaseImport(probe)) {
    throw new Error(`Database dependency guard missed ${probe}`)
  }
}

for (const file of sourceFiles('apps/desktop/src/main/db')) {
  if (/\.test\.[cm]?[jt]sx?$/.test(file)) continue
  for (const specifier of importsOf(file)) {
    if (isForbiddenDatabaseImport(specifier)) {
      violations.push(`${file}: database module must only depend on database and shared types, not ${specifier}`)
    }
  }
}

const classificationHandlerSource = readFileSync(classificationHandler, 'utf8')
const classificationHandlerPolicyPatterns = [
  [/(?:^|\s)(?:if|switch|for|while|try)\s*(?:\(|\{)/m, 'control flow'],
  [/\.(?:prepare|exec|transaction)\s*\(/, 'database operations'],
  [/\b(?:readFile|writeFile|unlink|rename|copyFile|mkdir|rm)\w*\s*\(/, 'filesystem operations'],
  [/adapter\.register\([\s\S]*?=>\s*\{/, 'block-bodied IPC callbacks']
]
for (const [pattern, label] of classificationHandlerPolicyPatterns) {
  if (pattern.test(classificationHandlerSource)) {
    violations.push(
      `${classificationHandler}: ${label} belong in an application service, not an IPC handler`
    )
  }
}

for (const file of [
  'apps/desktop/src/main/services/videoMaintenanceService.ts',
  'apps/desktop/src/main/services/videoScrapeApplyService.ts',
  'apps/desktop/src/main/services/actressQueryService.ts',
  'apps/desktop/src/main/services/actressMaintenanceService.ts',
  'apps/desktop/src/main/services/actressGalleryService.ts',
  'apps/desktop/src/main/services/actressIdentityConflictWorkflow.ts',
  'apps/desktop/src/main/scrapers/actressScraperManager.ts',
  'apps/desktop/src/main/scrapers/scraperManager.ts'
]) {
  for (const specifier of importsOf(file)) {
    if (
      specifier.endsWith('/assetService') ||
      specifier === './assetService' ||
      specifier.endsWith('/mediaAssetStoreFs') ||
      specifier === './mediaAssetStoreFs' ||
      specifier.includes('/mediaAssetStore/') ||
      specifier.startsWith('./mediaAssetStore/')
    ) {
      violations.push(`${file}: media writes and downloads must go through MediaAssetStore`)
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'))
  process.exit(1)
}

console.log('Domain IPC, shared types, and process dependency boundaries are valid.')
