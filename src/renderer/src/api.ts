// Thin convenience wrapper around the preload-exposed window.api.
export const api = window.api

/** Convert a stored relative asset path into a media:// URL the renderer can load. */
export function assetUrl(relPath: string | null | undefined): string | null {
  if (!relPath) return null
  // Stored as e.g. "covers/abc.jpg" -> media://covers/abc.jpg
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  return `media://${normalized}`
}

/** Resolve a stored asset path or remote URL for display. */
export function resolveMediaSrc(path: string | null | undefined): string | null {
  const trimmed = path?.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return assetUrl(trimmed)
}
