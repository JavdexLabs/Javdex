import type { AppSettings } from '@shared/types'
import type {
  CompositeScraperInput,
  ScraperPluginDescriptor,
  ScraperPluginKind,
  ScraperPluginPackage,
  ScraperPluginUpdateInput
} from '@shared/scrapeTypes'
import { DEFAULT_SETTINGS } from '@shared/types'
import { listActressScraperNames, listActressScraperPlugins } from '../scrapers/actressScraperManager'
import { listScraperNames, listScraperPlugins } from '../scrapers/scraperManager'
import {
  createCompositeScraper,
  deleteCompositeScraper,
  deleteScraperPlugin,
  exportScraperPluginPackage,
  importScraperPluginPackage,
  pluginPackageDefaultName,
  readScraperPluginPackage,
  updateCompositeScraper,
  updateScraperPluginConfig
} from '../scrapers/scraperPluginService'
import { getSettings, updateSettings } from '../settings/settingsStore'

export interface ScraperPluginCatalogDependencies {
  listNames(kind: ScraperPluginKind): string[]
  listPlugins(kind: ScraperPluginKind): ScraperPluginDescriptor[]
  importPackage(filePath: string): Promise<ScraperPluginDescriptor>
  exportPackage(kind: ScraperPluginKind, name: string, filePath: string): void
  readPackage(kind: ScraperPluginKind, name: string): ScraperPluginPackage
  updatePlugin(
    kind: ScraperPluginKind,
    name: string,
    input: ScraperPluginUpdateInput
  ): ScraperPluginDescriptor
  deletePlugin(kind: ScraperPluginKind, name: string): boolean
  createComposite(kind: ScraperPluginKind, input: CompositeScraperInput): ScraperPluginDescriptor
  updateComposite(
    kind: ScraperPluginKind,
    name: string,
    input: CompositeScraperInput
  ): ScraperPluginDescriptor
  deleteComposite(kind: ScraperPluginKind, name: string): boolean
  packageDefaultName(kind: ScraperPluginKind, name: string): string
  getSettings(): AppSettings
  updateSettings(update: Partial<AppSettings>): AppSettings | void
  defaultVideoScraper: string
  defaultActressScraper: string
}

export class ScraperPluginCatalog {
  constructor(private readonly dependencies: ScraperPluginCatalogDependencies) {}

  listNames(kind: ScraperPluginKind): string[] {
    return this.dependencies.listNames(kind)
  }

  listPlugins(kind: ScraperPluginKind): ScraperPluginDescriptor[] {
    return this.dependencies.listPlugins(kind)
  }

  importPackage(filePath: string): Promise<ScraperPluginDescriptor> {
    return this.dependencies.importPackage(filePath)
  }

  exportPackage(kind: ScraperPluginKind, name: string, filePath: string): void {
    this.dependencies.exportPackage(kind, name, filePath)
  }

  readPackage(kind: ScraperPluginKind, name: string): ScraperPluginPackage {
    return this.dependencies.readPackage(kind, name)
  }

  updatePlugin(
    kind: ScraperPluginKind,
    name: string,
    input: ScraperPluginUpdateInput
  ): ScraperPluginDescriptor {
    return this.dependencies.updatePlugin(kind, name, input)
  }

  deletePlugin(kind: ScraperPluginKind, name: string): boolean {
    const deleted = this.dependencies.deletePlugin(kind, name)
    this.restoreDefaultIfDeleted(kind, name)
    return deleted
  }

  createComposite(
    kind: ScraperPluginKind,
    input: CompositeScraperInput
  ): ScraperPluginDescriptor {
    return this.dependencies.createComposite(kind, input)
  }

  updateComposite(
    kind: ScraperPluginKind,
    name: string,
    input: CompositeScraperInput
  ): ScraperPluginDescriptor {
    return this.dependencies.updateComposite(kind, name, input)
  }

  deleteComposite(kind: ScraperPluginKind, name: string): boolean {
    const deleted = this.dependencies.deleteComposite(kind, name)
    this.restoreDefaultIfDeleted(kind, name)
    return deleted
  }

  packageDefaultName(kind: ScraperPluginKind, name: string): string {
    return this.dependencies.packageDefaultName(kind, name)
  }

  private restoreDefaultIfDeleted(kind: ScraperPluginKind, name: string): void {
    const settings = this.dependencies.getSettings()
    if (kind === 'video' && settings.defaultScraper === name) {
      this.dependencies.updateSettings({ defaultScraper: this.dependencies.defaultVideoScraper })
    }
    if (kind === 'actress' && settings.defaultActressScraper === name) {
      this.dependencies.updateSettings({
        defaultActressScraper: this.dependencies.defaultActressScraper
      })
    }
  }
}

export function createScraperPluginCatalog(
  dependencies: ScraperPluginCatalogDependencies
): ScraperPluginCatalog {
  return new ScraperPluginCatalog(dependencies)
}

export function createDefaultScraperPluginCatalog(): ScraperPluginCatalog {
  return createScraperPluginCatalog({
    listNames: (kind) => (kind === 'video' ? listScraperNames() : listActressScraperNames()),
    listPlugins: (kind) =>
      kind === 'video' ? listScraperPlugins() : listActressScraperPlugins(),
    importPackage: importScraperPluginPackage,
    exportPackage: exportScraperPluginPackage,
    readPackage: readScraperPluginPackage,
    updatePlugin: updateScraperPluginConfig,
    deletePlugin: deleteScraperPlugin,
    createComposite: createCompositeScraper,
    updateComposite: updateCompositeScraper,
    deleteComposite: deleteCompositeScraper,
    packageDefaultName: pluginPackageDefaultName,
    getSettings,
    updateSettings,
    defaultVideoScraper: DEFAULT_SETTINGS.defaultScraper,
    defaultActressScraper: DEFAULT_SETTINGS.defaultActressScraper
  })
}
