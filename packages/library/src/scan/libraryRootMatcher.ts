import path from 'node:path'
import { isPathUnderRoot } from './libraryPathUtils'

interface RootPath {
  path: string
  realPath?: string | null
}

/** Per-scan immutable roots; selection only, never a cached filesystem authorization. */
export function createLibraryRootMatcher<T extends RootPath>(
  roots: readonly T[],
  includeRealPath = false,
  paths: typeof path = path
): (filePath: string) => T | undefined {
  const matches = (filePath: string, root: T): boolean =>
    isPathUnderRoot(filePath, root.path, paths) ||
    Boolean(includeRealPath && root.realPath && isPathUnderRoot(filePath, root.realPath, paths))
  const fallback = (filePath: string): T | undefined => roots.find(root => matches(filePath, root))
  if (!roots.length) return () => undefined

  const windows = paths.sep === '\\'
  const special = (value: string): boolean => windows && /^\\\\[?.]\\/.test(value)
  const hasFixedWindowsRoot = (value: string): boolean =>
    /^[a-z]:\\/i.test(value) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(value)
  const key = (value: string): string => windows ? value.toLowerCase() : value
  const byPath = new Map<string, number>()
  for (let ordinal = 0; ordinal < roots.length; ordinal++) {
    const root = roots[ordinal]
    const aliases = includeRealPath && root.realPath ? [root.path, root.realPath] : [root.path]
    for (const alias of aliases) {
      // Keep deferred validation, relative-root cwd semantics and unusual Windows namespaces.
      if (typeof alias !== 'string' || !paths.isAbsolute(alias) || special(alias)) return fallback
      if (windows && !hasFixedWindowsRoot(alias.replaceAll('/', '\\'))) return fallback
      const resolved = key(paths.resolve(alias))
      if (!byPath.has(resolved)) byPath.set(resolved, ordinal)
    }
  }

  return (filePath: string): T | undefined => {
    const resolved = paths.resolve(filePath)
    if (special(resolved)) return fallback(filePath)
    let current = resolved
    let first = roots.length
    for (;;) {
      const ordinal = byPath.get(key(current))
      // Preserve legacy '..hidden' rejection and first-root order, not longest-prefix order.
      if (ordinal !== undefined && ordinal < first && matches(filePath, roots[ordinal])) first = ordinal
      const parent = paths.dirname(current)
      if (parent === current) break
      current = parent
    }
    return first === roots.length ? undefined : roots[first]
  }
}
