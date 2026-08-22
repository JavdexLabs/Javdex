export interface InspectLinkCandidate {
  href: string
  inContentRegion: boolean
  inNavigationRegion: boolean
  isLocaleLink: boolean
}

/**
 * Stable-partition inspect links before applying maxLinks. Content links are
 * most useful to the scraper agent, while navigation and locale links are
 * fallback context. Deduplication happens after partitioning so a content copy
 * wins when the same URL also appears in navigation.
 */
export function prioritizeInspectLinks<T extends InspectLinkCandidate>(
  candidates: readonly T[],
  maxLinks: number
): T[] {
  const limit = Math.max(0, Math.floor(maxLinks))
  if (limit === 0) return []

  const content: T[] = []
  const other: T[] = []
  const navigation: T[] = []

  for (const candidate of candidates) {
    if (candidate.inNavigationRegion || candidate.isLocaleLink) {
      navigation.push(candidate)
    } else if (candidate.inContentRegion) {
      content.push(candidate)
    } else {
      other.push(candidate)
    }
  }

  const result: T[] = []
  const seen = new Set<string>()
  for (const candidate of [...content, ...other, ...navigation]) {
    if (!candidate.href || seen.has(candidate.href)) continue
    seen.add(candidate.href)
    result.push(candidate)
    if (result.length >= limit) break
  }
  return result
}
