import type { ScraperPluginPackage } from './scraperPluginTypes'

/** Fields that affect scrape behavior. Display metadata such as name is omitted. */
export function pluginRuntimeIdentity(pkg: ScraperPluginPackage): {
  schemaVersion: ScraperPluginPackage['schemaVersion']
  kind: ScraperPluginPackage['kind']
  supportedFields: NonNullable<ScraperPluginPackage['supportedFields']>
  code: string
} {
  return {
    schemaVersion: pkg.schemaVersion,
    kind: pkg.kind,
    supportedFields: pkg.supportedFields ?? [],
    code: pkg.code
  }
}
