import { useLibraryDataSync } from '../hooks/useLibraryDataSync'

/** Invisible root subscriber for global library cache sync. */
export default function LibraryDataSync(): null {
  useLibraryDataSync()
  return null
}
