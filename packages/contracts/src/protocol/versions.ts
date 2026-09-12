/**
 * Conservative aggregate versions. A primary key does not replace a version.
 * `generation` changes when an id is deleted and later reused; `revision`
 * increments on each semantic change of that generation.
 */
export const VERSION_SCOPES = ['V', 'R', 'A', 'F', 'P', 'L', 'C', 'G', 'Q'] as const
export type VersionScope = (typeof VERSION_SCOPES)[number]

export interface AggregateVersion {
  generation: number
  revision: number
}

export interface ExpectedVersions {
  V?: AggregateVersion
  R?: AggregateVersion
  A?: AggregateVersion
  F?: AggregateVersion
  P?: AggregateVersion
  L?: AggregateVersion
  C?: AggregateVersion
  G?: AggregateVersion
  Q?: AggregateVersion
}

export const VERSION_SCOPE_MEANING: Record<VersionScope, string> = {
  V: 'One canonical video: fields, rating, relations, official images, links, scrape status, business identity',
  R: 'One (libraryId, videoId) membership plus its resource set and primary resource',
  A: 'One actress profile, names, official images, status, merge/delete',
  F: 'One organization, director, or series record',
  P: 'One playlist: metadata, cover, links, ordered members',
  L: 'One media-library row (name, archive, position)',
  C: 'One independently saved config record (library config or catalog settings snapshot)',
  G: 'One root-binding config; live file guard is checked separately',
  Q: 'One pending record or atomic confirmation group'
}
