import { isScraperPluginRunnable } from '../scrapers/scraperPluginService'
import {
  createMediaLibraryService,
  createMediaLibraryServiceDependencies
} from '@library/catalog/mediaLibraryService'

export {
  createMediaLibraryService,
  createMediaLibraryServiceDependencies,
  type MediaLibraryServiceDependencies
} from '@library/catalog/mediaLibraryService'

export const mediaLibraryService = createMediaLibraryService(
  createMediaLibraryServiceDependencies({
    isVideoScraperRunnable: (name) => isScraperPluginRunnable('video', name)
  })
)
