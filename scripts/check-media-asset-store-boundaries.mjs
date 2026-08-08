import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

function sourceFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(fullPath)
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [fullPath] : []
  })
}

function importsOf(file) {
  const source = readFileSync(file, 'utf8')
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

function isPrivateMediaAssetImpl(specifier) {
  return (
    specifier.includes('/mediaAssetStore/') ||
    specifier.startsWith('./mediaAssetStore/') ||
    specifier.startsWith('../mediaAssetStore/') ||
    specifier === './mediaAssetStoreFs' ||
    specifier === '../mediaAssetStoreFs' ||
    specifier.endsWith('/mediaAssetStoreFs') ||
    specifier === './assetService' ||
    specifier === '../assetService' ||
    specifier.endsWith('/assetService')
  )
}

const publicStore = path.resolve('src/main/services/mediaAssetStore.ts')
const privateRoot = path.resolve('src/main/services/mediaAssetStore')

const violations = []

for (const file of sourceFiles('src')) {
  const resolved = path.resolve(file)
  const insidePrivateTree =
    resolved === privateRoot || resolved.startsWith(`${privateRoot}${path.sep}`)
  if (resolved === publicStore || insidePrivateTree) continue

  for (const specifier of importsOf(file)) {
    if (!isPrivateMediaAssetImpl(specifier)) continue
    violations.push(
      `${file.replaceAll('\\', '/')}: media asset internals are private to MediaAssetStore; import mediaAssetStore instead of ${specifier}`
    )
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'))
  process.exit(1)
}

console.log('MediaAssetStore implementation boundaries are valid.')
