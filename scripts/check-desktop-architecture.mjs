import path from 'node:path'
import { importsOf, sourceFiles } from './lib/import-boundary-check.mjs'
import { readFileSync } from 'node:fs'

function relative(file) {
  return path.relative(process.cwd(), file).replaceAll('\\', '/')
}

function productionFiles(root) {
  return sourceFiles(root).filter((file) => !/\.test\.[cm]?[jt]sx?$/.test(file))
}

function valueImportSpecifiers(source) {
  const specifiers = []
  for (const match of source.matchAll(
    /^[ \t]*import\s+(type\s+)?(?:[^'"\n]+?\s+from\s+)?(['"])([^'"]+)\2/gm
  )) {
    specifiers.push({ typeOnly: Boolean(match[1]), specifier: match[3] })
  }
  for (const match of source.matchAll(
    /^[ \t]*export\s+(type\s+)?(?:\*|\{[^}]*\})\s+from\s+(['"])([^'"]+)\2/gm
  )) {
    specifiers.push({ typeOnly: Boolean(match[1]), specifier: match[3] })
  }
  return specifiers
}

const probeMatches = valueImportSpecifiers(`import type { A } from '../services/query'
import { B } from '../services/maintenance'
export type { C } from '@library/db/database'
export { D } from '@library/db/videoRepo'
`)
if (
  JSON.stringify(probeMatches) !==
  JSON.stringify([
    { typeOnly: true, specifier: '../services/query' },
    { typeOnly: false, specifier: '../services/maintenance' },
    { typeOnly: true, specifier: '@library/db/database' },
    { typeOnly: false, specifier: '@library/db/videoRepo' }
  ])
) {
  throw new Error(`desktop architecture parser probe failed: ${JSON.stringify(probeMatches)}`)
}

const violations = []

const catalogIpcFiles = [
  'apps/desktop/src/main/ipc/index.ts',
  'apps/desktop/src/main/ipc/videoHandlers.ts',
  'apps/desktop/src/main/ipc/actressHandlers.ts',
  'apps/desktop/src/main/ipc/facetHandlers.ts',
  'apps/desktop/src/main/ipc/playlistHandlers.ts',
  'apps/desktop/src/main/ipc/mediaLibraryHandlers.ts'
]

function isCatalogIpcForbidden(specifier) {
  return (
    specifier.startsWith('@library/db') ||
    specifier.startsWith('@library/catalog') ||
    /(?:^|\/)services\//.test(specifier)
  )
}

for (const file of catalogIpcFiles) {
  for (const { typeOnly, specifier } of valueImportSpecifiers(readFileSync(file, 'utf8'))) {
    if (!typeOnly && isCatalogIpcForbidden(specifier)) {
      violations.push(
        `${file}: catalog IPC must not import repositories or business singletons (${specifier})`
      )
    }
  }
}

for (const root of ['apps/desktop/src/preload', 'apps/desktop/src/renderer/src']) {
  for (const file of productionFiles(root)) {
    for (const specifier of importsOf(file)) {
      const resolved = specifier.startsWith('.')
        ? path.resolve(path.dirname(file), specifier).replaceAll('\\', '/')
        : specifier
      if (
        specifier.startsWith('@library/') ||
        specifier.startsWith('@javdex/library') ||
        specifier.startsWith('@http/') ||
        specifier.startsWith('@javdex/http') ||
        /(?:^|\/)packages\/(?:library|http)\//.test(resolved) ||
        /(?:^|\/)apps\/server\//.test(resolved)
      ) {
        violations.push(
          `${relative(file)}: renderer/preload must not import library, http, or server (${specifier})`
        )
      }
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'))
  process.exit(1)
}

console.log(
  'Desktop architecture import boundaries are valid for catalog IPC and renderer/preload.'
)
