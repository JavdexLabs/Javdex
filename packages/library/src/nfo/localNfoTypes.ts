import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import type { DirectoryVideoIdentityInput } from './directoryVideoIdentity'

export interface LocalNfoAnchor {
  root: Readonly<MediaLibraryRoot>
  anchorPath: string
  directoryVideoCodes: DirectoryVideoIdentityInput
  directorySidecars?: ReadonlyMap<string, string>
}

export interface LocalNfoIdentityInspection {
  status: 'missing' | 'warning' | 'found'
  code: string | null
  warnings: string[]
}
