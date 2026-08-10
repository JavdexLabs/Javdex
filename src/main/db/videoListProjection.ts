import type { Video, VideoResourceKind } from '@shared/videoTypes'

const VIDEO_RESOURCE_KINDS = new Set<VideoResourceKind>([
  'local',
  'direct',
  'web',
  'magnet',
  'ed2k'
])

export type VideoListProjectionRow = Video & { resource_kinds_csv?: string | null }

/** Shared projection for every surface that renders a video card. */
export function videoListSelectExtras(videoAlias = 'v'): string {
  return `,
    (SELECT vr.locator
     FROM video_resources vr
     WHERE vr.video_id = ${videoAlias}.id AND vr.kind = 'local'
     ORDER BY vr.is_primary DESC, vr.id ASC
     LIMIT 1) AS primary_file_path,
    (SELECT COUNT(*)
     FROM video_resources vr
     WHERE vr.video_id = ${videoAlias}.id AND vr.kind = 'local') AS file_count,
    (SELECT vr.kind
     FROM video_resources vr
     WHERE vr.video_id = ${videoAlias}.id AND vr.is_primary = 1
     ORDER BY vr.id ASC
     LIMIT 1) AS primary_resource_kind,
    (SELECT COUNT(*)
     FROM video_resources vr
     WHERE vr.video_id = ${videoAlias}.id) AS resource_count,
    (SELECT group_concat(resource_kind, ',')
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

export function hydrateVideoListRows(rows: VideoListProjectionRow[]): Video[] {
  return rows.map((row) => {
    const { resource_kinds_csv: resourceKindsCsv, ...video } = row
    const resourceKinds = (resourceKindsCsv?.split(',') ?? []).filter(
      (kind): kind is VideoResourceKind => VIDEO_RESOURCE_KINDS.has(kind as VideoResourceKind)
    )
    return { ...video, resource_kinds: resourceKinds }
  })
}
