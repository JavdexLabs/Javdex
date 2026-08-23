export interface InspectLinkCandidate {
  href: string
  inContentRegion: boolean
  inNavigationRegion: boolean
  isLocaleLink: boolean
}

export const INSPECT_MAX_LOCALE_LINKS = 24
export const INSPECT_MAX_SCRIPT_SRCS = 24
export const INSPECT_MAX_INLINE_SCRIPTS = 8
export const INSPECT_INLINE_SCRIPT_TEXT_LIMIT = 4_000

export interface InspectScriptSrc {
  href: string
  rawHref?: string
}

/** Keep external script URLs in document order. This is not a search-script API. */
export function selectInspectScriptSrcs<T extends InspectScriptSrc>(
  candidates: readonly T[],
  maxScripts = INSPECT_MAX_SCRIPT_SRCS
): T[] {
  const limit = Math.max(0, Math.floor(maxScripts))
  if (limit === 0) return []
  const result: T[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate.href || seen.has(candidate.href)) continue
    seen.add(candidate.href)
    result.push(candidate)
    if (result.length >= limit) break
  }
  return result
}

/** Keep locale anchors in document order. They are a separate pageFacts section, not a language API. */
export function selectInspectLocaleLinks<T extends InspectLinkCandidate>(
  candidates: readonly T[],
  maxLinks = 24
): T[] {
  const limit = Math.max(0, Math.floor(maxLinks))
  if (limit === 0) return []

  const result: T[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate.isLocaleLink || !candidate.href || seen.has(candidate.href)) continue
    seen.add(candidate.href)
    result.push(candidate)
    if (result.length >= limit) break
  }
  return result
}

/** Keep rawHref only when the HTML attribute differs from the resolved href. */
export function inspectLinkRawHref(
  resolvedHref: string,
  rawHref: string | null | undefined
): string | undefined {
  const raw = rawHref?.trim()
  if (!raw || raw === resolvedHref) return undefined
  return raw
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
