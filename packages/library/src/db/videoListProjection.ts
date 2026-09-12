import type { Video, VideoCard, VideoResourceKind } from '@shared/videoTypes'

const VIDEO_RESOURCE_KINDS = new Set<VideoResourceKind>([
  'local',
  'direct',
  'web',
  'magnet',
  'ed2k'
])

export type VideoListProjectionRow = Video & { resource_kinds_csv?: string | null }

/** Classification names are read-model projections; videos persist only stable entity ids. */
export function videoClassificationSelectExtras(videoAlias = 'v'): string {
  return `,
    (SELECT o.main_name FROM organizations o WHERE o.id = ${videoAlias}.maker_organization_id) AS maker,
    (SELECT o.main_name FROM organizations o WHERE o.id = ${videoAlias}.publisher_organization_id) AS publisher,
    (SELECT s.main_name FROM series s WHERE s.id = ${videoAlias}.series_id) AS series,
    (SELECT d.main_name FROM directors d WHERE d.id = ${videoAlias}.director_id) AS director,
    EXISTS (
      SELECT 1 FROM pending_video_scrapes pvs WHERE pvs.video_id = ${videoAlias}.id
    ) AS has_pending_scrape`
}

/** Shared projection for every surface that renders a video card. */
export function videoListSelectExtras(videoAlias = 'v'): string {
  return `${videoClassificationSelectExtras(videoAlias)},
    (SELECT vr.kind
     FROM video_resources vr
     WHERE vr.video_id = ${videoAlias}.id AND vr.is_primary = 1
     ORDER BY vr.id ASC
     LIMIT 1) AS primary_resource_kind,
    (SELECT COUNT(*)
     FROM video_resources vr
     WHERE vr.video_id = ${videoAlias}.id) AS resource_count,
    ${resourceKindsSelect(videoAlias)}`
}

function resourceKindsSelect(videoAlias: string): string {
  return `(SELECT group_concat(resource_kind, ',')
     FROM (
       SELECT vr.kind AS resource_kind,
              MAX(vr.is_primary) AS has_primary,
              MIN(vr.add_time) AS first_added,
              MIN(vr.id) AS first_id
       FROM video_resources vr
       WHERE vr.video_id = ${videoAlias}.id
       GROUP BY vr.kind
       ORDER BY has_primary DESC, first_added ASC, first_id ASC
     )) AS resource_kinds_csv`
}

export type VideoCardProjectionRow = Omit<VideoCard, 'resource_kinds' | 'has_pending_scrape'> & {
  resource_kinds_csv: string | null
  has_pending_scrape: number | boolean
}

export function videoCardSelect(videoAlias = 'v'): string {
  return `${videoAlias}.id, ${videoAlias}.code, ${videoAlias}.title, ${videoAlias}.cover_path,
    ${videoAlias}.scraped_status,
    EXISTS (SELECT 1 FROM pending_video_scrapes pvs WHERE pvs.video_id = ${videoAlias}.id) AS has_pending_scrape,
    ${resourceKindsSelect(videoAlias)}`
}

export function hydrateVideoCardRows(rows: VideoCardProjectionRow[]): VideoCard[] {
  return rows.map(({ resource_kinds_csv, has_pending_scrape, ...card }) => ({
    ...card,
    has_pending_scrape: Boolean(has_pending_scrape),
    resource_kinds: (resource_kinds_csv?.split(',') ?? []).filter(
      (kind): kind is VideoResourceKind => VIDEO_RESOURCE_KINDS.has(kind as VideoResourceKind)
    )
  }))
}

export function hydrateVideoListRows(rows: VideoListProjectionRow[]): Video[] {
  return rows.map((row) => {
    const { resource_kinds_csv: resourceKindsCsv, ...video } = row
    const resourceKinds = (resourceKindsCsv?.split(',') ?? []).filter(
      (kind): kind is VideoResourceKind => VIDEO_RESOURCE_KINDS.has(kind as VideoResourceKind)
    )
    return { ...video, has_pending_scrape: Boolean(video.has_pending_scrape), resource_kinds: resourceKinds }
  })
}
