import type { ActressScrapeField } from './actressScrapeTypes'
import type { VideoScrapeField } from './videoScrapeTypes'

export type ScraperPluginKind = 'video' | 'actress'
export type ScraperPluginSource = 'builtin' | 'user' | 'composite'

export interface ScraperPluginDelay {
  minMs: number
  maxMs: number
}

export interface ScraperPluginDelaySettings {
  video: Record<string, ScraperPluginDelay>
  actress: Record<string, ScraperPluginDelay>
}

export interface CompositeScraperDefinition {
  kind: ScraperPluginKind
  name: string
  description?: string
  fieldPluginMap: Partial<Record<VideoScrapeField | ActressScrapeField, string>>
}

export interface ScraperPluginDescriptor {
  kind: ScraperPluginKind
  name: string
  version: string
  description: string
  author?: string
  homepage?: string
  source: ScraperPluginSource
  removable: boolean
  exportable: boolean
  editable?: boolean
  debuggable?: boolean
  overridesBuiltIn?: boolean
  requiresConfiguration?: boolean
  configured?: boolean
  configurationLabel?: string
  disabledReason?: string
  supportedFields: Array<VideoScrapeField | ActressScrapeField>
  delay?: ScraperPluginDelay
  fieldPluginMap?: Partial<Record<VideoScrapeField | ActressScrapeField, string>>
}

export interface ScraperPluginPackage {
  schemaVersion: 1
  kind: ScraperPluginKind
  name: string
  version?: string
  description?: string
  author?: string
  homepage?: string
  supportedFields?: Array<VideoScrapeField | ActressScrapeField>
  code: string
}

export type ScraperPluginPackageExport = ScraperPluginPackage
export type ScraperPluginPackageImport = ScraperPluginPackage

export interface ScraperPluginUpdateInput {
  version?: string
  description?: string
  author?: string
  homepage?: string
  supportedFields?: Array<VideoScrapeField | ActressScrapeField>
  delay?: ScraperPluginDelay
}

export interface CompositeScraperInput {
  name: string
  description?: string
  fieldPluginMap: Partial<Record<VideoScrapeField | ActressScrapeField, string>>
}
