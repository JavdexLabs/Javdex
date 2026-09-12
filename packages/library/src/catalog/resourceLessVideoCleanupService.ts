import { purgeResourceLessVideos } from '@library/db/videoRepo'
import { mediaAssetStore } from '@library/mediaAssetStore'

export function deleteResourceLessVideos(): number {
  return mediaAssetStore.coordinateDatabaseChange(() => {
    const result = purgeResourceLessVideos()
    for (const assetPath of result.obsoletePaths) {
      mediaAssetStore.deleteBestEffort(assetPath)
    }
    return result.deleted
  })
}
