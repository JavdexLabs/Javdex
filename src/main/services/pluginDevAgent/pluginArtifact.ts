import { createHash } from 'node:crypto'
import type { ScraperPluginPackage } from '@shared/scraperPluginTypes'

/** Stable identity shared by workspace snapshots, checks and the user-driven install gate. */
export function pluginArtifactHash(pkg: ScraperPluginPackage): string {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: pkg.schemaVersion,
    kind: pkg.kind,
    name: pkg.name,
    version: pkg.version ?? '',
    description: pkg.description ?? '',
    author: pkg.author ?? '',
    homepage: pkg.homepage ?? '',
    supportedFields: pkg.supportedFields ?? [],
    code: pkg.code
  })).digest('hex')
}
