import { createHash } from 'node:crypto'
import { pluginRuntimeIdentity } from '@shared/pluginRuntimeIdentity'
import type { ScraperPluginPackage } from '@shared/scraperPluginTypes'

/** Stable runtime identity shared by workspace snapshots, checks and the install gate. */
export function pluginArtifactHash(pkg: ScraperPluginPackage): string {
  return createHash('sha256').update(JSON.stringify(pluginRuntimeIdentity(pkg))).digest('hex')
}
