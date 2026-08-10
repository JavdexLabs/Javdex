import type Database from 'better-sqlite3'
import type {
  OrganizationDeleteImpact,
  OrganizationDeleteResult,
  OrganizationRole,
  OrganizationRoleRemovalImpact,
  OrganizationRoleRemovalResult
} from '@shared/classificationTypes'
import { getDb } from '../db/database'
import { cleanupClassificationImage } from './classificationImageCleanup'
import { mediaAssetStore } from './mediaAssetStore'
import { findSeriesOwnershipScopeConflict } from './seriesOwnershipScopeConflict'

const ROLE_COLUMNS: Record<
  OrganizationRole,
  { idColumn: 'maker_organization_id' | 'publisher_organization_id'; textColumn: 'maker' | 'publisher' }
> = {
  maker: { idColumn: 'maker_organization_id', textColumn: 'maker' },
  publisher: { idColumn: 'publisher_organization_id', textColumn: 'publisher' }
}

interface OrganizationDeletionServiceDependencies {
  database: () => Database.Database
  deleteStoredImage: (storedPath: string) => void
}

export interface OrganizationDeletionService {
  previewRoleRemoval(id: number, role: OrganizationRole): OrganizationRoleRemovalImpact
  removeRole(id: number, role: OrganizationRole): OrganizationRoleRemovalResult
  previewOrganization(id: number): OrganizationDeleteImpact
  deleteOrganization(id: number): OrganizationDeleteResult
}

function requireIdentity(id: number, role?: OrganizationRole): void {
  if (!Number.isInteger(id) || id <= 0) throw new Error('机构删除参数无效')
  if (role != null && role !== 'maker' && role !== 'publisher') {
    throw new Error('机构角色无效')
  }
}

function readRoles(database: Database.Database, id: number): OrganizationRole[] {
  return (
    database
      .prepare('SELECT role FROM organization_roles WHERE organization_id = ? ORDER BY role')
      .all(id) as Array<{ role: OrganizationRole }>
  ).map((item) => item.role)
}

function assertOrganizationExists(database: Database.Database, id: number): string | null {
  const row = database.prepare('SELECT image_path FROM organizations WHERE id = ?').get(id) as
    | { image_path: string | null }
    | undefined
  if (!row) throw new Error('机构不存在')
  return row.image_path
}

function roleVideoCount(
  database: Database.Database,
  id: number,
  role: OrganizationRole
): number {
  const column = ROLE_COLUMNS[role].idColumn
  return (
    database.prepare(`SELECT COUNT(*) AS count FROM videos WHERE ${column} = ?`).get(id) as {
      count: number
    }
  ).count
}

function readRoleImpact(
  database: Database.Database,
  id: number,
  role: OrganizationRole
): OrganizationRoleRemovalImpact {
  requireIdentity(id, role)
  assertOrganizationExists(database, id)
  const roles = readRoles(database, id)
  if (!roles.includes(role)) throw new Error('当前机构没有该角色')
  const remainingRoles = roles.filter((item) => item !== role)
  return {
    id,
    role,
    roleVideoCount: roleVideoCount(database, id, role),
    remainingRoles,
    canRemove: remainingRoles.length > 0
  }
}

function readDeleteImpact(
  database: Database.Database,
  id: number
): OrganizationDeleteImpact & { imagePath: string | null } {
  requireIdentity(id)
  const imagePath = assertOrganizationExists(database, id)
  const row = database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM videos WHERE maker_organization_id = ?) AS maker_video_count,
         (SELECT COUNT(*) FROM videos WHERE publisher_organization_id = ?) AS publisher_video_count,
         (SELECT COUNT(*) FROM organizations WHERE parent_organization_id = ?) AS direct_child_count,
         (SELECT COUNT(*) FROM series WHERE owner_organization_id = ?) AS owned_series_count`
    )
    .get(id, id, id, id) as {
      maker_video_count: number
      publisher_video_count: number
      direct_child_count: number
      owned_series_count: number
    }
  return {
    id,
    makerVideoCount: row.maker_video_count,
    publisherVideoCount: row.publisher_video_count,
    directChildCount: row.direct_child_count,
    ownedSeriesCount: row.owned_series_count,
    imagePath
  }
}

function assertUnownedSeriesScopeAvailable(
  database: Database.Database,
  organizationId: number
): void {
  const conflict = findSeriesOwnershipScopeConflict(database, organizationId, null)
  if (!conflict) return
  throw new Error(
    `机构所属系列 #${conflict.incomingSeriesId}“${conflict.incomingSeriesName}”的名称` +
      `“${conflict.conflictingName}”与未归属系列 #${conflict.existingSeriesId}` +
      `“${conflict.existingSeriesName}”冲突；请先修改或合并冲突系列`
  )
}

export function createOrganizationDeletionService(
  dependencies: Partial<OrganizationDeletionServiceDependencies> = {}
): OrganizationDeletionService {
  const database = dependencies.database ?? getDb
  const deleteStoredImage =
    dependencies.deleteStoredImage ?? ((storedPath) => mediaAssetStore.delete(storedPath))

  return {
    previewRoleRemoval(id, role): OrganizationRoleRemovalImpact {
      return readRoleImpact(database(), id, role)
    },

    removeRole(id, role): OrganizationRoleRemovalResult {
      const db = database()
      return db.transaction(() => {
        const impact = readRoleImpact(db, id, role)
        if (!impact.canRemove) {
          throw new Error('最后一个机构角色不能单独移除；请改用完整删除机构')
        }
        const columns = ROLE_COLUMNS[role]
        const unlinkedVideoCount = db
          .prepare(
            `UPDATE videos
             SET ${columns.idColumn} = NULL, ${columns.textColumn} = NULL, updated_at = ?
             WHERE ${columns.idColumn} = ?`
          )
          .run(new Date().toISOString(), id).changes
        db.prepare('DELETE FROM organization_roles WHERE organization_id = ? AND role = ?').run(
          id,
          role
        )
        return { id, role, unlinkedVideoCount, remainingRoles: impact.remainingRoles }
      })()
    },

    previewOrganization(id): OrganizationDeleteImpact {
      const { imagePath: _imagePath, ...impact } = readDeleteImpact(database(), id)
      return impact
    },

    deleteOrganization(id): OrganizationDeleteResult {
      const db = database()
      const committed = db.transaction(() => {
        const impact = readDeleteImpact(db, id)
        assertUnownedSeriesScopeAvailable(db, id)
        const now = new Date().toISOString()
        const unlinkedMakerVideoCount = db
          .prepare(
            `UPDATE videos SET maker_organization_id = NULL, maker = NULL, updated_at = ?
             WHERE maker_organization_id = ?`
          )
          .run(now, id).changes
        const unlinkedPublisherVideoCount = db
          .prepare(
            `UPDATE videos SET publisher_organization_id = NULL, publisher = NULL, updated_at = ?
             WHERE publisher_organization_id = ?`
          )
          .run(now, id).changes
        const detachedChildCount = db
          .prepare(
            `UPDATE organizations SET parent_organization_id = NULL, updated_at = ?
             WHERE parent_organization_id = ?`
          )
          .run(now, id).changes
        const detachedSeriesCount = db
          .prepare(
            `UPDATE series SET owner_organization_id = NULL, updated_at = ?
             WHERE owner_organization_id = ?`
          )
          .run(now, id).changes
        db.prepare(
          `UPDATE series_name_ownership SET owner_organization_id = NULL
           WHERE owner_organization_id = ?`
        ).run(id)
        db.prepare('DELETE FROM organizations WHERE id = ?').run(id)
        return {
          id,
          unlinkedMakerVideoCount,
          unlinkedPublisherVideoCount,
          detachedChildCount,
          detachedSeriesCount,
          imagePath: impact.imagePath
        }
      })()
      const { imagePath, ...result } = committed
      return {
        ...result,
        cleanupFailures: cleanupClassificationImage(imagePath, deleteStoredImage)
      }
    }
  }
}

export const organizationDeletionService = createOrganizationDeletionService()
