import type { ScraperPluginKind } from '@shared/scraperPluginTypes'
import { appendCheerioDryRunHint } from '@shared/scrapeFieldPromptDocs'
import { getPluginDevKindProfile } from '@shared/pluginDevKindProfile'

/** True when package already has a real implementation, not the empty parser stub. */
export function hasSubstantialPluginCode(kind: ScraperPluginKind, code: string): boolean {
  const trimmed = code.trim()
  if (trimmed.length > 320) return true
  return getPluginDevKindProfile(kind).substantialCodePattern.test(trimmed)
}

export { appendCheerioDryRunHint }
