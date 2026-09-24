import { normalizeLocalPathIdentity } from './localPathIdentity'

export function buildStrmResourceKey(sourcePath: string): string {
  return `strm:${normalizeLocalPathIdentity(sourcePath)}`
}
