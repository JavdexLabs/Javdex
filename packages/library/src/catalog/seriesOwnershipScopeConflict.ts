import type Database from 'better-sqlite3'

export interface SeriesOwnershipScopeConflict {
  incomingSeriesId: number
  incomingSeriesName: string
  conflictingName: string
  existingSeriesId: number
  existingSeriesName: string
}

export function findSeriesOwnershipScopeConflict(
  database: Database.Database,
  incomingOwnerOrganizationId: number,
  targetOwnerOrganizationId: number | null
): SeriesOwnershipScopeConflict | null {
  const row = database
    .prepare(
      `SELECT incoming.series_id AS incoming_series_id,
              incoming_series.main_name AS incoming_series_name,
              COALESCE(incoming_name.name, incoming_series.main_name) AS conflicting_name,
              existing.series_id AS existing_series_id,
              existing_series.main_name AS existing_series_name
       FROM series_name_ownership incoming
       JOIN series incoming_series ON incoming_series.id = incoming.series_id
       JOIN series_name_ownership existing
         ON existing.owner_organization_id IS ?
        AND existing.normalized_name = incoming.normalized_name
       JOIN series existing_series ON existing_series.id = existing.series_id
       LEFT JOIN series_names incoming_name
         ON incoming_name.series_id = incoming.series_id
        AND incoming_name.normalized_name = incoming.normalized_name
       WHERE incoming.owner_organization_id = ?
         AND incoming.series_id <> existing.series_id
       LIMIT 1`
    )
    .get(targetOwnerOrganizationId, incomingOwnerOrganizationId) as
    | {
        incoming_series_id: number
        incoming_series_name: string
        conflicting_name: string
        existing_series_id: number
        existing_series_name: string
      }
    | undefined
  if (!row) return null
  return {
    incomingSeriesId: row.incoming_series_id,
    incomingSeriesName: row.incoming_series_name,
    conflictingName: row.conflicting_name,
    existingSeriesId: row.existing_series_id,
    existingSeriesName: row.existing_series_name
  }
}
