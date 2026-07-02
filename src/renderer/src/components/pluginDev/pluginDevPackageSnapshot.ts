import type { ScraperPluginPackage } from '@shared/types'

export function fingerprintPluginPackage(pkg: ScraperPluginPackage): string {
  return JSON.stringify({
    schemaVersion: pkg.schemaVersion,
    kind: pkg.kind,
    name: pkg.name,
    version: pkg.version ?? '',
    description: pkg.description ?? '',
    author: pkg.author ?? '',
    homepage: pkg.homepage ?? '',
    supportedFields: pkg.supportedFields ?? [],
    code: pkg.code
  })
}
