import path from 'node:path'

/** Stable identity for persisted local paths; display paths keep their original casing. */
export function normalizeLocalPathIdentity(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved
}

/**
 * Validate and canonicalize an absolute local path before it crosses into a database module.
 * Keeping lexical path policy here prevents persistence modules from depending on Node's fs/path
 * APIs while still giving every caller one stable identity contract.
 */
export function normalizeAbsoluteLocalPath(filePath: string): {
  path: string
  normalizedPath: string
} {
  if (typeof filePath !== 'string') throw new Error('本地路径必须是字符串。')
  const trimmed = filePath.trim()
  if (!trimmed || trimmed.includes('\0') || !path.isAbsolute(trimmed)) {
    throw new Error('本地路径必须是有效的绝对路径。')
  }
  const resolvedPath = path.normalize(path.resolve(trimmed))
  return { path: resolvedPath, normalizedPath: normalizeLocalPathIdentity(resolvedPath) }
}

/** Both arguments must already use normalizeLocalPathIdentity. */
export function isNormalizedLocalPathUnderRoot(
  normalizedPath: string,
  normalizedRoot: string
): boolean {
  const relative = path.relative(normalizedRoot, normalizedPath)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
