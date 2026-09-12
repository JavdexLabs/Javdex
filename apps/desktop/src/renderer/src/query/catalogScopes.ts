import type { CatalogScope } from '@shared/mediaLibraryTypes'

/** Explicit global catalog scope for renderer surfaces that are not library-owned. */
export const ALL_CATALOG_SCOPE: CatalogScope = Object.freeze({ kind: 'all' })

export function mediaLibraryCatalogScope(libraryId: number): CatalogScope {
  return { kind: 'library', libraryId }
}
