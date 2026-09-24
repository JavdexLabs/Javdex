import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

function sourceFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(fullPath)
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [fullPath] : []
  })
}

function repoPath(file) {
  return path.relative('.', file).replaceAll('\\', '/')
}

const violations = []
const schemaSource = readFileSync('packages/library/src/db/schema.ts', 'utf8')
for (const column of ['maker', 'publisher', 'series', 'director']) {
  if (new RegExp(`^\\s*${column}\\s+TEXT\\b`, 'm').test(schemaSource)) {
    violations.push(`packages/library/src/db/schema.ts: videos.${column} must not return as text storage`)
  }
}
if (/CREATE TABLE IF NOT EXISTS facet_entries/.test(schemaSource)) {
  violations.push('packages/library/src/db/schema.ts: facet_entries is retired')
}
if (existsSync('packages/library/src/db/facetRepo.ts')) {
  violations.push('packages/library/src/db/facetRepo.ts: legacy text facet repository is retired')
}

for (const root of ['apps/desktop/src/main', 'packages/library/src']) {
  for (const file of sourceFiles(root)) {
    const normalizedFile = repoPath(file)
    if (normalizedFile === 'packages/library/src/db/migrations.ts' || /\.test\.[cm]?[jt]sx?$/.test(normalizedFile)) {
      continue
    }
    const source = readFileSync(file, 'utf8')
    if (/\bfacet_entries\b/.test(source)) {
      violations.push(`${normalizedFile}: runtime code must not access facet_entries`)
    }
    if (/\bv\.(maker|publisher|series|director)\b/.test(source)) {
      violations.push(`${normalizedFile}: video queries must filter classification entities by stable ids`)
    }
    if (/\bSET\s+(?:[^;\n]*,\s*)?(maker|publisher|series|director)\s*=/i.test(source)) {
      violations.push(`${normalizedFile}: video writes must not restore classification text columns`)
    }
  }
}

const routeSource = readFileSync('apps/desktop/src/renderer/src/listView/routePaths.ts', 'utf8')
if (/\/v\/:valueKey|facet(?:Detail|VideoStack|ActressStack)/.test(routeSource)) {
  violations.push('apps/desktop/src/renderer/src/listView/routePaths.ts: name-based classification routes are retired')
}

if (violations.length > 0) {
  console.error(violations.join('\n'))
  process.exit(1)
}

console.log('Classification entity storage and routing boundaries are valid.')
