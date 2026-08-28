import type { MediaLibraryDetail } from '@shared/mediaLibraryTypes'

export type MediaLibrarySurfaceMode = 'missing' | 'archived' | 'active'

export function mediaLibrarySurfaceMode(
  library: Pick<MediaLibraryDetail, 'status'> | null | undefined
): MediaLibrarySurfaceMode {
  if (!library) return 'missing'
  return library.status === 'archived' ? 'archived' : 'active'
}
