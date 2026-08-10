import path from 'node:path'

export function isPathUnderRoot(filePath: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(filePath))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function isSameLibraryPath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right)
}
