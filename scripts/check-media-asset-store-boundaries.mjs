import path from 'node:path'
import { importsOf, sourceFiles } from './lib/import-boundary-check.mjs'

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

const publicStore = path.resolve('apps/desktop/src/main/services/mediaAssetStore.ts')
const privateRoot = path.resolve('apps/desktop/src/main/services/mediaAssetStore')

const violations = []

for (const file of ['apps', 'packages'].flatMap(sourceFiles)) {
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
