import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

function sourceFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(fullPath)
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [fullPath] : []
  })
}

const violations = []
const schemaSource = readFileSync('apps/desktop/src/main/db/schema.ts', 'utf8')
for (const column of ['maker', 'publisher', 'series', 'director']) {
  if (new RegExp(`^\\s*${column}\\s+TEXT\\b`, 'm').test(schemaSource)) {
    violations.push(`apps/desktop/src/main/db/schema.ts: videos.${column} must not return as text storage`)
  }
}
if (/CREATE TABLE IF NOT EXISTS facet_entries/.test(schemaSource)) {
  violations.push('apps/desktop/src/main/db/schema.ts: facet_entries is retired')
}
if (existsSync('apps/desktop/src/main/db/facetRepo.ts')) {
  violations.push('apps/desktop/src/main/db/facetRepo.ts: legacy text facet repository is retired')
}

for (const file of sourceFiles('apps/desktop/src/main')) {
  const normalizedFile = file.replaceAll('\\', '/')
  if (normalizedFile === 'apps/desktop/src/main/db/migrations.ts' || /\.test\.[cm]?[jt]sx?$/.test(normalizedFile)) continue
  const source = readFileSync(file, 'utf8')
  if (/\bfacet_entries\b/.test(source)) {
    violations.push(`${file}: runtime code must not access facet_entries`)
  }
  if (/\bv\.(maker|publisher|series|director)\b/.test(source)) {
    violations.push(`${file}: video queries must filter classification entities by stable ids`)
  }
  if (/\bSET\s+(?:[^;\n]*,\s*)?(maker|publisher|series|director)\s*=/i.test(source)) {
    violations.push(`${file}: video writes must not restore classification text columns`)
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
