import type { ActressFaceScanManifestItem } from '@shared/actressTypes'
import { actressKeys } from '../query/queryKeys'

export function actressFaceScanManifestQueryOptions(
  fetchManifest: () => Promise<ActressFaceScanManifestItem[]>
) {
  return {
    queryKey: actressKeys.faceScanManifest(),
    queryFn: fetchManifest,
    staleTime: Infinity,
    enabled: false
  }
}
