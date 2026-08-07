import { readFileSync, readdirSync } from 'node:fs'
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
const channelSource = readFileSync('src/shared/ipc-channels.ts', 'utf8')
const contractSource = readFileSync('src/shared/actressIpcContract.ts', 'utf8')
const actressChannels = [...channelSource.matchAll(/\b(ACTRESS_[A-Z0-9_]+)\s*:/g)].map(
  (match) => match[1]
)
for (const channel of actressChannels) {
  if (!contractSource.includes(`[IPC.${channel}]`)) {
    violations.push(`src/shared/actressIpcContract.ts: missing contract for IPC.${channel}`)
  }
}

for (const file of sourceFiles('src/renderer/src')) {
  for (const specifier of importsOf(file)) {
    if (/(^|\/)main(\/|$)/.test(specifier) || specifier.startsWith('@main/')) {
      violations.push(`${file}: renderer must not import main-process module ${specifier}`)
    }
  }
}

const actressHandler = 'src/main/ipc/actressHandlers.ts'
for (const specifier of importsOf(actressHandler)) {
  if (
    /\.\.\/(db|scrapers)\//.test(specifier) ||
    (/\.\.\/services\//.test(specifier) &&
      specifier !== '../services/actressApplicationService')
  ) {
    violations.push(`${actressHandler}: actress IPC must delegate through its application service`)
  }
}

for (const file of sourceFiles('src/main/db')) {
  if (/\.test\.[cm]?[jt]sx?$/.test(file)) continue
  for (const specifier of importsOf(file)) {
    const upperService =
      /\.\.\/services\//.test(specifier) &&
      !['../services/assetService', '../services/assetCrypto'].includes(specifier)
    if (/\.\.\/(ipc|scrapers)\//.test(specifier) || upperService) {
      violations.push(`${file}: database module must not depend on an upper application layer`)
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'))
  process.exit(1)
}

console.log('Actress dependency boundaries are valid.')
