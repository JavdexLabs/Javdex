import type Database from 'better-sqlite3'
import type {
  ClassificationEntityKind,
  ClassificationEntityRef,
  ClassificationImageCleanupFailure,
  ClassificationImageInput,
  ClassificationImageUpdateResult
} from '@shared/classificationTypes'
import { getDb } from '../db/database'
import { fetchRemoteImageBuffer } from './remoteImageFetch'
import { mediaAssetStore } from './mediaAssetStore'

const ENTITY_TABLE: Record<ClassificationEntityKind, 'organizations' | 'directors' | 'series'> = {
  organization: 'organizations',
  director: 'directors',
  series: 'series'
}

type StoredClassificationImage = {
  main_name: string
  image_path: string | null
}

interface ClassificationImageServiceDependencies {
  fetchRemoteImage: (url: string) => Promise<Buffer>
  deleteStoredImage: (path: string) => void
  database: () => Database.Database
}

export interface ClassificationImageService {
  setImage(
    entity: ClassificationEntityRef,
    input: ClassificationImageInput | null
  ): Promise<ClassificationImageUpdateResult>
}

function assertEntityRef(entity: ClassificationEntityRef): void {
  if (!Number.isInteger(entity.id) || entity.id <= 0 || !(entity.kind in ENTITY_TABLE)) {
    throw new Error('分类实体参数无效')
  }
}

function assertImageInput(input: ClassificationImageInput | null): void {
  if (input === null) return
  if (!input || typeof input !== 'object') throw new Error('分类主图来源参数无效')
  if (input.source === 'file' && typeof input.sourcePath === 'string' && input.sourcePath.trim()) {
    return
  }
  if (input.source === 'url' && typeof input.remoteUrl === 'string' && input.remoteUrl.trim()) {
    return
  }
  if (input.source === 'video-cover' && Number.isInteger(input.videoId) && input.videoId > 0) {
    return
  }
  throw new Error('分类主图来源参数无效')
}

function readEntity(
  database: Database.Database,
  entity: ClassificationEntityRef
): StoredClassificationImage {
  const row = database
    .prepare(`SELECT main_name, image_path FROM ${ENTITY_TABLE[entity.kind]} WHERE id = ?`)
    .get(entity.id) as StoredClassificationImage | undefined
  if (!row) throw new Error('分类实体不存在')
  return row
}

function readAssociatedVideoCover(
  database: Database.Database,
  entity: ClassificationEntityRef,
  videoId: number
): string {
  if (!Number.isInteger(videoId) || videoId <= 0) throw new Error('关联影片封面不存在')
  const predicate =
    entity.kind === 'organization'
      ? '(maker_organization_id = ? OR publisher_organization_id = ?)'
      : entity.kind === 'director'
        ? 'director_id = ?'
        : 'series_id = ?'
  const parameters =
    entity.kind === 'organization' ? [videoId, entity.id, entity.id] : [videoId, entity.id]
  const row = database
    .prepare(
      `SELECT cover_path FROM videos
       WHERE id = ? AND ${predicate} AND cover_path IS NOT NULL AND trim(cover_path) != ''`
    )
    .get(...parameters) as { cover_path: string } | undefined
  if (!row) throw new Error('关联影片封面不存在')
  return row.cover_path
}

function normalizedRemoteUrl(rawUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw new Error('图片链接必须是有效的 HTTP/HTTPS 地址')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('图片链接必须是有效的 HTTP/HTTPS 地址')
  }
  return parsed.toString()
}

export function createClassificationImageService(
  dependencies: Partial<ClassificationImageServiceDependencies> = {}
): ClassificationImageService {
  const fetchRemoteImage = dependencies.fetchRemoteImage ?? fetchRemoteImageBuffer
  const deleteStoredImage = dependencies.deleteStoredImage ?? ((path) => mediaAssetStore.delete(path))
  const database = dependencies.database ?? getDb

  return {
    async setImage(entity, input): Promise<ClassificationImageUpdateResult> {
      assertEntityRef(entity)
      assertImageInput(input)
      const db = database()
      const change = await mediaAssetStore.coordinateDatabaseChange(async () => {
        const entityAtStart = readEntity(db, entity)
        let imagePath: string | null = null
        if (input?.source === 'file') {
          imagePath = mediaAssetStore.importClassificationImage(
            entity.kind,
            entity.id,
            entityAtStart.main_name,
            input.sourcePath
          )
        } else if (input?.source === 'url') {
          const data = await fetchRemoteImage(normalizedRemoteUrl(input.remoteUrl))
          imagePath = mediaAssetStore.storeClassificationImage(
            entity.kind,
            entity.id,
            entityAtStart.main_name,
            data
          )
        } else if (input?.source === 'video-cover') {
          const coverPath = readAssociatedVideoCover(db, entity, input.videoId)
          imagePath = mediaAssetStore.storeClassificationImage(
            entity.kind,
            entity.id,
            entityAtStart.main_name,
            mediaAssetStore.readBytes(coverPath)
          )
        }
        return db.transaction(() => {
          const current = readEntity(db, entity)
          const update = db.prepare(
            `UPDATE ${ENTITY_TABLE[entity.kind]} SET image_path = ?, updated_at = ? WHERE id = ?`
          ).run(imagePath, new Date().toISOString(), entity.id)
          if (update.changes !== 1) throw new Error('分类实体主图更新失败')
          return { imagePath, previousPath: current.image_path }
        })()
      })

      const cleanupFailures: ClassificationImageCleanupFailure[] = []
      if (change.previousPath && change.previousPath !== change.imagePath) {
        try {
          deleteStoredImage(change.previousPath)
        } catch (error) {
          cleanupFailures.push({
            path: change.previousPath,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
      return { imagePath: change.imagePath, cleanupFailures }
    }
  }
}

export const classificationImageService = createClassificationImageService()
