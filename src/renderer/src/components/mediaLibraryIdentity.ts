import type { CSSProperties } from 'react'
import type { MediaLibraryColor } from '@shared/mediaLibraryTypes'

type MediaLibraryIdentityStyle = CSSProperties & {
  '--media-library-color': string
}

const MEDIA_LIBRARY_COLOR_TOKEN: Record<MediaLibraryColor, string> = {
  slate: 'var(--text-muted)',
  blue: 'var(--accent)',
  violet: 'color-mix(in srgb, var(--accent) 66%, var(--danger))',
  rose: 'var(--danger)',
  amber: 'var(--warning)',
  green: 'var(--success)'
}

/** Shared visual identity seam for every compact media-library marker. */
export function mediaLibraryIdentityStyle(
  color: MediaLibraryColor
): MediaLibraryIdentityStyle {
  return { '--media-library-color': MEDIA_LIBRARY_COLOR_TOKEN[color] }
}
