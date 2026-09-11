import path from 'node:path'

export function isPathUnderRoot(filePath: string, root: string, paths: typeof path = path): boolean {
  const relative = paths.relative(paths.resolve(root), paths.resolve(filePath))
  return relative === '' || (!relative.startsWith('..') && !paths.isAbsolute(relative))
}

export function isSameLibraryPath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right)
}
