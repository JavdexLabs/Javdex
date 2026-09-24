import path from 'node:path'
import { isBuiltin } from 'node:module'
import { importsOf, sourceFiles } from './lib/import-boundary-check.mjs'

function isForbiddenHttpImport(specifier, fromFile) {
  const resolved = specifier.startsWith('.')
    ? path.resolve(path.dirname(fromFile), specifier).replaceAll('\\', '/')
    : specifier
  return (
    specifier === 'electron' ||
    specifier.startsWith('electron/') ||
    /^(?:playwright(?:-core)?(?:\/|$))/.test(specifier) ||
    specifier.startsWith('@renderer/') ||
    /^(?:@javdex\/(?:desktop|server)(?:\/|$))/.test(specifier) ||
    /(?:^|\/)apps\/desktop\//.test(resolved) ||
    /(?:^|\/)apps\/server\//.test(resolved)
  )
}

const parserProbeFile = path.resolve('packages/http/src/server.ts')
for (const [specifier, shouldForbid] of [
  ['electron', true],
  ['electron/main', true],
  ['playwright-core', true],
  ['../../../../apps/desktop/src/main/settings/settingsStore', true],
  ['@shared/webTypes', false],
  ['@library/mediaAssetStore', false],
  ['node:http', false]
]) {
  const forbidden = isForbiddenHttpImport(specifier, parserProbeFile)
  if (forbidden !== shouldForbid) {
    throw new Error(
      `http boundary guard ${shouldForbid ? 'missed' : 'false-positive on'} ${specifier}`
    )
  }
}

if (isBuiltin('node:http') !== true) {
  throw new Error('http boundary probe expected node:http to be a builtin')
}

const violations = []
for (const file of sourceFiles('packages/http/src')) {
  if (/\.test\.[cm]?[jt]sx?$/.test(file)) continue
  for (const specifier of importsOf(file)) {
    if (isForbiddenHttpImport(specifier, file)) {
      violations.push(
        `${file.replaceAll('\\', '/')}: production http code must not import desktop, Electron, Playwright, or the server entry (${specifier})`
      )
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'))
  process.exit(1)
}

console.log('HTTP production import boundaries are valid.')
