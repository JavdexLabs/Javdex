import { normalizeVideoCode } from '@shared/videoCode'

/** Constant field count, not fixed bytes: the normalized code retains its string length. */
export interface DirectoryVideoIdentitySummary {
  readonly kind: 'summary'
  readonly count: number
  readonly normalizedCode: string | null
  readonly consistent: boolean
}

export type DirectoryVideoIdentityInput = readonly (string | null)[] | DirectoryVideoIdentitySummary

const EMPTY: DirectoryVideoIdentitySummary = Object.freeze({
  kind: 'summary', count: 0, normalizedCode: null, consistent: false
})

/** Returns a new immutable snapshot; never mutates a summary retained by an anchor. */
export function appendDirectoryVideoCode(
  previous: DirectoryVideoIdentitySummary | undefined,
  code: string | null
): DirectoryVideoIdentitySummary {
  let normalized: string | null = null
  if (code) {
    try { normalized = normalizeVideoCode(code) } catch { /* Invalid identities stay ambiguous. */ }
  }
  const first = !previous || previous.count === 0
  return Object.freeze({
    kind: 'summary', count: (previous?.count ?? 0) + 1,
    normalizedCode: first ? normalized : previous.normalizedCode,
    consistent: normalized !== null && (first || (previous.consistent && normalized === previous.normalizedCode))
  })
}

export function summarizeDirectoryVideoCodes(values: Iterable<string | null>): DirectoryVideoIdentitySummary {
  let summary = EMPTY
  for (const code of values) summary = appendDirectoryVideoCode(summary, code)
  return summary
}

/** Legacy singleton behavior deliberately accepts even an unknown/invalid code. */
export function sameLogicalCode(values: DirectoryVideoIdentityInput): boolean {
  if ('kind' in values) {
    return values.count === 1 || (values.count > 0 && values.consistent && Boolean(values.normalizedCode))
  }
  if (values.length === 1) return true
  if (values.length === 0) return false
  let first: string | undefined
  for (const value of values) {
    if (!value) return false
    let normalized: string
    try { normalized = normalizeVideoCode(value) } catch { return false }
    if (first === undefined) first = normalized
    else if (normalized !== first) return false
  }
  return Boolean(first)
}
