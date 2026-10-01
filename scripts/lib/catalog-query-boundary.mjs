import path from 'node:path'

// The two migrated host entry points must use the shared query module. Other
// legacy hosts migrate incrementally; this is not a blanket repository ban.
const migrated = new Set([
  'apps/server/src/manageDispatch.ts',
  'apps/desktop/src/main/services/videoQueryService.ts'
])

export function bypassesCatalogQuery(specifier, fromFile) {
  const file = path.relative(process.cwd(), path.resolve(fromFile)).replaceAll('\\', '/')
  if (!migrated.has(file)) return false
  const resolved = specifier.startsWith('.')
    ? path.relative(process.cwd(), path.resolve(path.dirname(fromFile), specifier)).replaceAll('\\', '/')
    : specifier.replace(/^@(?:library\/|javdex\/library\/)/u, 'packages/library/src/')
  return /^packages\/library\/src\/db\/(?:videoRepo|scopedVideoCatalogRepo)(?:\.[cm]?[jt]s)?$/u.test(resolved)
}
