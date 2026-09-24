import type { ScraperPluginDelay, ScraperPluginKind } from './scraperPluginTypes'
import { LOCAL_NFO_SOURCE_NAME } from './videoMetadataSourceConstants'

export const PLUGIN_DEFAULT_DELAYS: Partial<
  Record<ScraperPluginKind, Record<string, ScraperPluginDelay>>
> = {
  video: {
    MetaTube: { minMs: 0, maxMs: 0 },
    [LOCAL_NFO_SOURCE_NAME]: { minMs: 0, maxMs: 0 }
  },
  actress: {
    Gfriends: { minMs: 0, maxMs: 0 }
  }
}
