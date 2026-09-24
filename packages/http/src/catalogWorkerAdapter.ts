import type Database from 'better-sqlite3'
import type { WebBrowse } from '@shared/webTypes'
import { WebCatalog, type WebCatalogReader } from './catalog'
import {
  parseWebBrowseQuery,
  normalizeWebSeed,
  WebCatalogQueryError,
  type WebBrowseQuery,
  type WebCollections,
  type WebHome
} from './catalogQueryRequest'
import { WebError } from './http'

/** Desktop/server inject the catalog query worker; HTTP never imports the worker entry. */
export interface WebCatalogQueryReads {
  readWebBrowse(query: WebBrowseQuery, signal?: AbortSignal): Promise<WebBrowse> | WebBrowse
  readWebHome(seed: string, signal?: AbortSignal): Promise<WebHome> | WebHome
  readWebCollections(signal?: AbortSignal): Promise<WebCollections> | WebCollections
}

/** Only catalog queries cross the worker boundary; media authorization stays local. */
export function createWorkerWebCatalog(
  db: Database.Database,
  reads: WebCatalogQueryReads
): WebCatalogReader {
  const resources = new WebCatalog(db)
  const validated = <T>(read: () => T): T => {
    try {
      return read()
    } catch (error) {
      if (error instanceof WebCatalogQueryError) throw new WebError(400, error.message)
      throw error
    }
  }
  return {
    browse: (query, signal) => reads.readWebBrowse(validated(() => parseWebBrowseQuery(query)), signal),
    home: (seed, signal) => reads.readWebHome(validated(() => normalizeWebSeed(seed)), signal),
    collections: (signal) => reads.readWebCollections(signal),
    detail: (id) => resources.detail(id),
    image: (id, key, signal, size) => resources.image(id, key, signal, size),
    media: (id, resourceId, download) => resources.media(id, resourceId, download)
  }
}
