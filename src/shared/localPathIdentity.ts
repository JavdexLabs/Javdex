import path from 'node:path'

/** Stable identity for persisted local paths; display paths keep their original casing. */
export function normalizeLocalPathIdentity(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved
}
