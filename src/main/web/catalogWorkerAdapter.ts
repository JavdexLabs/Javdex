import type Database from 'better-sqlite3'
import type { CatalogReadWorkerClient } from '../services/catalogReadWorkerClient'
import { WebCatalog, type WebCatalogReader } from './catalog'
import { parseWebBrowseQuery, normalizeWebSeed, WebCatalogQueryError } from './catalogQueryRequest'
import { WebError } from './http'

type Reads = Pick<CatalogReadWorkerClient, 'readWebBrowse' | 'readWebHome' | 'readWebCollections'>

/** Only catalog queries cross the worker boundary; media authorization stays local. */
export function createWorkerWebCatalog(db: Database.Database, reads: Reads): WebCatalogReader {
  const resources = new WebCatalog(db)
  const validated = <T>(read: () => T): T => {
    try { return read() }
    catch (error) {
      if (error instanceof WebCatalogQueryError) throw new WebError(400,error.message)
      throw error
    }
  }
  return {
    browse: (query, signal) => reads.readWebBrowse(validated(()=>parseWebBrowseQuery(query)),signal),
    home: (seed, signal) => reads.readWebHome(validated(()=>normalizeWebSeed(seed)),signal),
    collections: signal => reads.readWebCollections(signal),
    detail: id => resources.detail(id),
    image: (id,key,signal,size) => resources.image(id,key,signal,size),
    media: (id,resourceId,download) => resources.media(id,resourceId,download)
  }
}
