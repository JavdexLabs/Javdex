import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createScraperPluginCatalog } from './scraperPluginCatalog'

describe('ScraperPluginCatalog', () => {
  // Sole catalog policy: default-scraper restore after delete (see ADR-0013).
  it('restores the configured default after deleting a selected plugin', () => {
    const updates: unknown[] = []
    const catalog = createScraperPluginCatalog({
      listNames: () => [],
      listPlugins: () => [],
      importPackage: async () => ({ name: 'custom' }) as never,
      exportPackage: () => undefined,
      readPackage: () => ({}) as never,
      updatePlugin: () => ({}) as never,
      deletePlugin: () => true,
      createComposite: () => ({}) as never,
      updateComposite: () => ({}) as never,
      deleteComposite: () => true,
      packageDefaultName: (kind, name) => `${name}.${kind}.json`,
      getSettings: () => ({ defaultScraper: 'custom', defaultActressScraper: 'custom' }) as never,
      updateSettings: (update) => {
        updates.push(update)
      },
      defaultVideoScraper: 'JavDB',
      defaultActressScraper: 'Xslist'
    })

    assert.equal(catalog.deletePlugin('video', 'custom'), true)
    assert.equal(catalog.deleteComposite('actress', 'custom'), true)
    assert.deepEqual(updates, [
      { defaultScraper: 'JavDB' },
      { defaultActressScraper: 'Xslist' }
    ])
  })
})
