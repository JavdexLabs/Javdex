import path from 'node:path'
import { isBuiltin } from 'node:module'
import { importsOf, sourceFiles } from './lib/import-boundary-check.mjs'

function isForbiddenLibraryImport(specifier, fromFile) {
  const resolved = specifier.startsWith('.')
    ? path.resolve(path.dirname(fromFile), specifier).replaceAll('\\', '/')
    : specifier
  return (
    specifier === 'electron' ||
    specifier.startsWith('electron/') ||
    /^(?:playwright(?:-core)?(?:\/|$))/.test(specifier) ||
    specifier.startsWith('@renderer/') ||
    /^(?:@javdex\/(?:desktop|server|http)(?:\/|$))/.test(specifier) ||
    /(?:^|\/)apps\/desktop\//.test(resolved) ||
    /(?:^|\/)apps\/server\//.test(resolved) ||
    /(?:^|\/)packages\/http\//.test(resolved)
  )
}

const parserProbeFile = path.resolve('packages/library/src/db/database.ts')
for (const [specifier, shouldForbid] of [
  ['electron', true],
  ['electron/main', true],
  ['playwright', true],
  ['playwright-core', true],
  ['@renderer/styles.css', true],
  ['@javdex/desktop', true],
  ['../../../../apps/desktop/src/main/settings/settingsStore', true],
  ['@shared/videoTypes', false],
  ['@library/localPathIdentity', false],
  ['better-sqlite3', false],
  ['node:fs', false]
]) {
  const forbidden = isForbiddenLibraryImport(specifier, parserProbeFile)
  if (forbidden !== shouldForbid) {
    throw new Error(
      `library boundary guard ${shouldForbid ? 'missed' : 'false-positive on'} ${specifier}`
    )
  }
}

if (isBuiltin('node:fs') !== true) {
  throw new Error('library boundary probe expected node:fs to be a builtin')
}

const violations = []
for (const file of sourceFiles('packages/library/src')) {
  if (/\.test\.[cm]?[jt]sx?$/.test(file)) continue
  for (const specifier of importsOf(file)) {
    if (isForbiddenLibraryImport(specifier, file)) {
      violations.push(
        `${file.replaceAll('\\', '/')}: production library code must not import desktop, Electron, Playwright, or reserved server/http (${specifier})`
      )
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'))
  process.exit(1)
}

console.log('Library production import boundaries are valid.')
