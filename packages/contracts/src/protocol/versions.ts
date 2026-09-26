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

export function expectedVideoVersion(video: {
  generation?: number | null
  revision?: number | null
}): ExpectedVersions {
  if (
    video.generation == null ||
    video.revision == null ||
    !Number.isInteger(video.generation) ||
    !Number.isInteger(video.revision) ||
    video.generation < 1 ||
    video.revision < 1
  ) {
    throw new Error('影片缺少版本信息，请刷新后重试')
  }
  return { V: { generation: video.generation, revision: video.revision } }
}

export function expectedActressVersion(actress: {
  generation?: number | null
  revision?: number | null
}): ExpectedVersions {
  if (
    actress.generation == null ||
    actress.revision == null ||
    !Number.isInteger(actress.generation) ||
    !Number.isInteger(actress.revision) ||
    actress.generation < 1 ||
    actress.revision < 1
  ) {
    throw new Error('演员缺少版本信息，请刷新后重试')
  }
  return { A: { generation: actress.generation, revision: actress.revision } }
}

export function expectedClassificationVersion(entity: {
  generation?: number | null
  revision?: number | null
}): ExpectedVersions {
  const version = expectedVersion(entity, '分类')
  return { F: version }
}

export function expectedPlaylistVersion(playlist: {
  generation?: number | null
  revision?: number | null
}): ExpectedVersions {
  const version = expectedVersion(playlist, '清单')
  return { P: version }
}

function expectedVersion(value: { generation?: number | null; revision?: number | null }, label: string): AggregateVersion {
  if (!Number.isSafeInteger(value.generation) || !Number.isSafeInteger(value.revision) ||
      (value.generation ?? 0) < 1 || (value.revision ?? 0) < 1) {
    throw new Error(`${label}缺少版本信息，请刷新后重试`)
  }
  return { generation: value.generation!, revision: value.revision! }
}
