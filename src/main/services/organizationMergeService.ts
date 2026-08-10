import type Database from 'better-sqlite3'
import type {
  OrganizationMergeInput,
  OrganizationMergeResult,
  OrganizationRole,
  OrganizationStatus
} from '@shared/classificationTypes'
import { normalizeClassificationName } from '@shared/classificationNameNormalization'
import { getDb } from '../db/database'
import {
  assertClassificationMergeInput,
  mergeClassificationAliases,
  mergeClassificationLinks,
  resolveClassificationMergeParent,
  targetFirstMeaningfulText,
  type ClassificationMergeLink,
  type ClassificationMergeName
} from './classificationMergeSupport'
import {
  cleanupClassificationImage,
  obsoleteSourceImagePath
} from './classificationImageCleanup'
import { mediaAssetStore } from './mediaAssetStore'
import {
  assertOrganizationNamesAvailable,
  writeOrganizationLinks,
  writeOrganizationNames
} from './organizationProfilePersistence'

type StoredOrganization = {
  id: number
  main_name: string
  image_path: string | null
  summary: string | null
  country_region: string | null
  founded_year: number | null
  ended_year: number | null
  status: OrganizationStatus
  parent_organization_id: number | null
}

interface OrganizationMergeServiceDependencies {
  database: () => Database.Database
  deleteStoredImage: (storedPath: string) => void
}

export interface OrganizationMergeService {
  merge(input: OrganizationMergeInput): OrganizationMergeResult
}

function readOrganization(database: Database.Database, id: number): StoredOrganization {
  const organization = database.prepare('SELECT * FROM organizations WHERE id = ?').get(id) as
    | StoredOrganization
    | undefined
  if (!organization) throw new Error('机构不存在')
  return organization
}

function readAliases(database: Database.Database, id: number): ClassificationMergeName[] {
  return database
    .prepare(
      `SELECT name, normalized_name FROM organization_names
       WHERE organization_id = ? AND type = 'alias'
       ORDER BY position, id`
    )
    .all(id) as ClassificationMergeName[]
}

function readLinks(database: Database.Database, id: number): ClassificationMergeLink[] {
  return database
    .prepare(
      `SELECT label, url, normalized_url, position FROM organization_links
       WHERE organization_id = ? ORDER BY position, id`
    )
    .all(id) as ClassificationMergeLink[]
}

function readRoles(database: Database.Database, id: number): OrganizationRole[] {
  return (
    database
      .prepare('SELECT role FROM organization_roles WHERE organization_id = ? ORDER BY role')
      .all(id) as Array<{ role: OrganizationRole }>
  ).map((row) => row.role)
}

function assertSeriesScopeAvailable(
  database: Database.Database,
  targetOrganizationId: number,
  sourceOrganizationId: number
): void {
  const conflict = database
    .prepare(
      `SELECT incoming.series_id AS incoming_series_id,
              incoming_series.main_name AS incoming_series_name,
              COALESCE(incoming_name.name, incoming_series.main_name) AS conflicting_name,
              existing.series_id AS existing_series_id,
              existing_series.main_name AS existing_series_name
       FROM series_name_ownership incoming
       JOIN series incoming_series ON incoming_series.id = incoming.series_id
       JOIN series_name_ownership existing
         ON existing.owner_organization_id = ?
        AND existing.normalized_name = incoming.normalized_name
       JOIN series existing_series ON existing_series.id = existing.series_id
       LEFT JOIN series_names incoming_name
         ON incoming_name.series_id = incoming.series_id
        AND incoming_name.normalized_name = incoming.normalized_name
       WHERE incoming.owner_organization_id = ?
         AND incoming.series_id <> existing.series_id
       LIMIT 1`
    )
    .get(targetOrganizationId, sourceOrganizationId) as
    | {
        incoming_series_id: number
        incoming_series_name: string
        conflicting_name: string
        existing_series_id: number
        existing_series_name: string
      }
    | undefined
  if (!conflict) return
  throw new Error(
    `来源系列 #${conflict.incoming_series_id}“${conflict.incoming_series_name}”的名称` +
      `“${conflict.conflicting_name}”与目标机构内系列 #${conflict.existing_series_id}` +
      `“${conflict.existing_series_name}”冲突；请先修改或合并冲突系列`
  )
}

function validateLifecycle(organization: StoredOrganization): void {
  if (
    organization.founded_year != null &&
    organization.ended_year != null &&
    organization.founded_year > organization.ended_year
  ) {
    throw new Error('合并后的成立年份不能晚于停止年份')
  }
}

export function createOrganizationMergeService(
  dependencies: Partial<OrganizationMergeServiceDependencies> = {}
): OrganizationMergeService {
  const database = dependencies.database ?? getDb
  const deleteStoredImage =
    dependencies.deleteStoredImage ?? ((storedPath) => mediaAssetStore.delete(storedPath))

  return {
    merge(input): OrganizationMergeResult {
      assertClassificationMergeInput(input, '机构')
      const db = database()
      const committed = db.transaction(() => {
        const target = readOrganization(db, input.targetId)
        const source = readOrganization(db, input.sourceId)
        const aliases = mergeClassificationAliases(
          target.main_name,
          readAliases(db, target.id),
          source.main_name,
          readAliases(db, source.id)
        )
        const links = mergeClassificationLinks(
          readLinks(db, target.id),
          readLinks(db, source.id)
        )
        const roles = new Set([...readRoles(db, target.id), ...readRoles(db, source.id)])
        const merged: StoredOrganization = {
          ...target,
          image_path: target.image_path ?? source.image_path,
          summary: targetFirstMeaningfulText(target.summary, source.summary),
          country_region: targetFirstMeaningfulText(
            target.country_region,
            source.country_region
          ),
          founded_year: target.founded_year ?? source.founded_year,
          ended_year: target.ended_year ?? source.ended_year,
          status: target.status !== 'unknown' ? target.status : source.status,
          parent_organization_id: resolveClassificationMergeParent(
            db,
            'organization',
            { id: target.id, parentId: target.parent_organization_id },
            { id: source.id, parentId: source.parent_organization_id }
          )
        }
        validateLifecycle(merged)
        const normalizedNames = [target.main_name, ...aliases].map((name) =>
          normalizeClassificationName(name)
        )
        assertOrganizationNamesAvailable(db, normalizedNames, [target.id, source.id])
        assertSeriesScopeAvailable(db, target.id, source.id)

        const now = new Date().toISOString()
        db.prepare(
          `UPDATE organizations
           SET image_path = ?, summary = ?, country_region = ?, founded_year = ?,
               ended_year = ?, status = ?, parent_organization_id = ?, updated_at = ?
           WHERE id = ?`
        ).run(
          merged.image_path,
          merged.summary,
          merged.country_region,
          merged.founded_year,
          merged.ended_year,
          merged.status,
          merged.parent_organization_id,
          now,
          target.id
        )
        db.prepare('DELETE FROM organization_name_ownership WHERE organization_id = ?').run(
          source.id
        )
        writeOrganizationNames(db, target.id, target.main_name, aliases)
        writeOrganizationLinks(db, target.id, links)
        const insertRole = db.prepare(
          'INSERT OR IGNORE INTO organization_roles (organization_id, role) VALUES (?, ?)'
        )
        roles.forEach((role) => insertRole.run(target.id, role))

        const transferredMakerVideoCount = db
          .prepare(
            `UPDATE videos
             SET maker_organization_id = ?, maker = ?, updated_at = ?
             WHERE maker_organization_id = ?`
          )
          .run(target.id, target.main_name, now, source.id).changes
        const transferredPublisherVideoCount = db
          .prepare(
            `UPDATE videos
             SET publisher_organization_id = ?, publisher = ?, updated_at = ?
             WHERE publisher_organization_id = ?`
          )
          .run(target.id, target.main_name, now, source.id).changes
        const transferredChildCount = db
          .prepare(
            `UPDATE organizations SET parent_organization_id = ?, updated_at = ?
             WHERE parent_organization_id = ? AND id <> ?`
          )
          .run(target.id, now, source.id, target.id).changes
        const transferredSeriesCount = db
          .prepare(
            `UPDATE series SET owner_organization_id = ?, updated_at = ?
             WHERE owner_organization_id = ?`
          )
          .run(target.id, now, source.id).changes
        db.prepare(
          `UPDATE series_name_ownership SET owner_organization_id = ?
           WHERE owner_organization_id = ?`
        ).run(target.id, source.id)
        db.prepare('DELETE FROM organizations WHERE id = ?').run(source.id)

        return {
          targetId: target.id,
          sourceId: source.id,
          transferredMakerVideoCount,
          transferredPublisherVideoCount,
          transferredChildCount,
          transferredSeriesCount,
          imagePath: merged.image_path,
          obsoleteImagePath: obsoleteSourceImagePath(target.image_path, source.image_path)
        }
      })()

      const { obsoleteImagePath, ...result } = committed
      return {
        ...result,
        cleanupFailures: cleanupClassificationImage(obsoleteImagePath, deleteStoredImage)
      }
    }
  }
}

export const organizationMergeService = createOrganizationMergeService()
