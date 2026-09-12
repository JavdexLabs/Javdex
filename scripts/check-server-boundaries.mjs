import path from 'node:path'
import { isBuiltin } from 'node:module'
import { importsOf, sourceFiles } from './lib/import-boundary-check.mjs'

function isForbiddenServerImport(specifier, fromFile) {
  const resolved = specifier.startsWith('.')
    ? path.resolve(path.dirname(fromFile), specifier).replaceAll('\\', '/')
    : specifier
  return (
    specifier === 'electron' ||
    specifier.startsWith('electron/') ||
    /^(?:playwright(?:-core)?(?:\/|$))/.test(specifier) ||
    specifier.startsWith('@renderer/') ||
    specifier.startsWith('@javdex/desktop') ||
    specifier.startsWith('@earendil-works/') ||
    /(?:^|\/)apps\/desktop\//.test(resolved)
  )
}

const probeFile = path.resolve('apps/server/src/index.ts')
for (const [specifier, shouldForbid] of [
  ['electron', true],
  ['playwright-core', true],
  ['@earendil-works/pi-coding-agent', true],
  ['../../desktop/src/main/appMain', true],
  ['@library/db/database', false],
  ['@http/server', false],
  ['node:http', false]
]) {
  const forbidden = isForbiddenServerImport(specifier, probeFile)
  if (forbidden !== shouldForbid) {
    throw new Error(
      `server boundary guard ${shouldForbid ? 'missed' : 'false-positive on'} ${specifier}`
    )
  }
}

if (isBuiltin('node:http') !== true) {
  throw new Error('server boundary probe expected node:http to be a builtin')
}

const violations = []
for (const file of sourceFiles('apps/server/src')) {
  if (/\.test\.[cm]?[jt]sx?$/.test(file)) continue
  for (const specifier of importsOf(file)) {
    if (isForbiddenServerImport(specifier, file)) {
      violations.push(
        `${file.replaceAll('\\', '/')}: production server code must not import desktop, Electron, Playwright, or the plugin agent (${specifier})`
      )
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'))
  process.exit(1)
}

console.log('Server production import boundaries are valid.')
