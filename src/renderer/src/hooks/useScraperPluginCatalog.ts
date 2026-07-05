import { useEffect, useState } from 'react'
import type { ScraperPluginDescriptor } from '@shared/types'
import { api } from '../api'

type ScraperKind = 'video' | 'actress'

/** Loads scraper names, plugin field coverage, and the configured default site. */
export function useScraperPluginCatalog(kind: ScraperKind): {
  scrapers: string[]
  pluginDetails: ScraperPluginDescriptor[]
  defaultScraper: string
} {
  const [scrapers, setScrapers] = useState<string[]>([])
  const [pluginDetails, setPluginDetails] = useState<ScraperPluginDescriptor[]>([])
  const [defaultScraper, setDefaultScraper] = useState('')

  useEffect(() => {
    const listPlugins = kind === 'video' ? api.scrape.listPlugins : api.actressScrape.listPlugins
    const listDetails =
      kind === 'video' ? api.scrape.listPluginDetails : api.actressScrape.listPluginDetails

    Promise.all([listPlugins(), listDetails(), api.settings.get()])
      .then(([names, details, settings]) => {
        setScrapers(names)
        setPluginDetails(details)
        setDefaultScraper(
          (kind === 'video' ? settings.defaultScraper : settings.defaultActressScraper) ||
            names[0] ||
            ''
        )
      })
      .catch(() => {})
  }, [kind])

  return { scrapers, pluginDetails, defaultScraper }
}
