import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ManualImportResult, RenameImportResult } from '@shared/libraryTypes'
import type { VideoResourceImportTarget } from '@shared/videoTypes'
import { structuredError } from '@shared/protocol/errors'
import { getMediaLibraryRoot } from '@library/db/mediaLibraryRepo'
import { getLocalVideoResourceByLocator, getVideoResourceInLibrary } from '@library/db/videoRepo'
import { getDb } from '@library/db/database'
import { normalizeLocalPathIdentity } from '@library/localPathIdentity'
import { isPathUnderRoot } from '@library/scan/libraryPathUtils'
import { authorizeMediaLibraryRootFile } from '@library/scan/mediaLibraryRootFileGuard'
import { importManual, renameAndImport } from '@library/scan/scanner'
import { maintenanceTaskGate } from '@library/scan/maintenanceTaskGate'
import { handoffWaitingBlocksNewMaintenance } from '@library/catalog/catalogWriter'
import {
  removeLibraryUnrecognizedFile,
  renameLibraryUnrecognizedFile
} from '@library/db/libraryScanRepo'

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function requireWritableParent(filePath: string): void {
  fs.accessSync(path.dirname(filePath), fs.constants.W_OK)
}

function resolveLocation(
  libraryId: number,
  location: { rootId: number; relativePath: string }
): { root: NonNullable<ReturnType<typeof getMediaLibraryRoot>>; filePath: string } {
  const root = getMediaLibraryRoot(libraryId, location.rootId)
  if (!root || root.state !== 'active') {
    throw structuredError('INVALID_INPUT', '媒体库根目录不存在、已停用或不属于该媒体库')
  }
  if (path.isAbsolute(location.relativePath)) {
    throw structuredError('INVALID_INPUT', '远程文件位置必须是根目录相对路径')
  }
  const base = root.realPath ?? root.path
  const filePath = path.resolve(base, location.relativePath)
  if (!isPathUnderRoot(filePath, base)) {
    throw structuredError('INVALID_INPUT', '文件不在授权根目录内')
  }
  return { root, filePath }
}

function fileFingerprint(filePath: string): { size: number; mtimeMs: number } | { missing: true } {
  try {
    const stat = fs.statSync(filePath)
    return { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) }
  } catch {
    return { missing: true }
  }
}

export function filesRenameDigest(input: {
  libraryId: number
  resourceId?: number
  location: { rootId: number; relativePath: string }
  newFileName: string
}): string {
  const { filePath } = resolveLocation(input.libraryId, input.location)
  return sha256({
    libraryId: input.libraryId,
    resourceId: input.resourceId ?? null,
    location: input.location,
    newFileName: input.newFileName,
    fingerprint: fileFingerprint(filePath)
  })
}

export function previewRenameCatalogFile(input: {
  libraryId: number
  location: { rootId: number; relativePath: string }
  newFileName: string
}): { resourceId?: number; planDigest: string } {
  const { filePath } = resolveLocation(input.libraryId, input.location)
  const resource = getLocalVideoResourceByLocator(input.libraryId, filePath)
  const resourceId = resource?.id
  return {
    ...(resourceId != null ? { resourceId } : {}),
    planDigest: filesRenameDigest({
      libraryId: input.libraryId,
      ...(resourceId != null ? { resourceId } : {}),
      location: input.location,
      newFileName: input.newFileName
    })
  }
}

function assertResourceOrUnrecognized(
  libraryId: number,
  resourceId: number | undefined,
  filePath: string
): void {
  if (resourceId != null) {
    const resource = getVideoResourceInLibrary(libraryId, resourceId)
    if (resource) {
      if (normalizeLocalPathIdentity(resource.locator) !== normalizeLocalPathIdentity(filePath)) {
        throw structuredError('INVALID_INPUT', '资源定位与文件位置不一致')
      }
      return
    }
    throw structuredError('INVALID_INPUT', '文件不是该媒体库中的资源或未识别项')
  }
  if (getLocalVideoResourceByLocator(libraryId, filePath)) {
    throw structuredError('INVALID_INPUT', '文件已登记为资源，缺少资源编号')
  }
  const unrecognized = getDb()
    .prepare(
      `SELECT 1 AS ok FROM library_unrecognized_files
        WHERE library_id = ? AND file_path = ?`
    )
    .get(libraryId, filePath) as { ok: number } | undefined
  if (!unrecognized) {
    throw structuredError('INVALID_INPUT', '文件不是该媒体库中的资源或未识别项')
  }
}

export async function renameCatalogFile(input: {
  libraryId: number
  resourceId?: number
  location: { rootId: number; relativePath: string }
  newFileName: string
  planDigest: string
}): Promise<RenameImportResult> {
  if (handoffWaitingBlocksNewMaintenance()) {
    throw structuredError('MAINTENANCE_BUSY', '交接等待期间不能开始新的维护')
  }
  if (filesRenameDigest(input) !== input.planDigest) {
    throw structuredError('VERSION_CONFLICT', '文件维护预览已过期，请刷新后重试')
  }
  const { root, filePath } = resolveLocation(input.libraryId, input.location)
  authorizeMediaLibraryRootFile(input.libraryId, root.id, filePath, root)
  assertResourceOrUnrecognized(input.libraryId, input.resourceId, filePath)
  try {
    requireWritableParent(filePath)
  } catch {
    throw structuredError('INVALID_INPUT', '只读挂载不允许维护写入')
  }
  return maintenanceTaskGate.run('resource-maintenance', async () => {
    const result = await renameAndImport({
      libraryId: input.libraryId,
      rootId: root.id,
      oldPath: filePath,
      newName: input.newFileName
    })
    if (result.outcome === 'imported' || result.outcome === 'pending') {
      removeLibraryUnrecognizedFile(input.libraryId, root.id, normalizeLocalPathIdentity(filePath))
    } else {
      renameLibraryUnrecognizedFile(input.libraryId, root.id, normalizeLocalPathIdentity(filePath), {
        filePath: result.newPath,
        normalizedPath: normalizeLocalPathIdentity(result.newPath)
      })
    }
    return result
  })
}

export async function importCatalogManualFile(input: {
  libraryId: number
  location: { rootId: number; relativePath: string }
  code: string
  target: VideoResourceImportTarget
}): Promise<ManualImportResult> {
  if (handoffWaitingBlocksNewMaintenance()) {
    throw structuredError('MAINTENANCE_BUSY', '交接等待期间不能开始新的维护')
  }
  const { root, filePath } = resolveLocation(input.libraryId, input.location)
  authorizeMediaLibraryRootFile(input.libraryId, root.id, filePath, root)
  try {
    requireWritableParent(filePath)
  } catch {
    throw structuredError('INVALID_INPUT', '只读挂载不允许维护写入')
  }
  return maintenanceTaskGate.run('resource-maintenance', async () => {
    const result = await importManual({
      libraryId: input.libraryId,
      rootId: root.id,
      filePath,
      code: input.code,
      target: input.target
    })
    if (result.imported || result.skippedPath) {
      removeLibraryUnrecognizedFile(input.libraryId, root.id, normalizeLocalPathIdentity(filePath))
    }
    return result
  })
}
