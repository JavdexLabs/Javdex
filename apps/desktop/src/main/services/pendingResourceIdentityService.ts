import fs from 'node:fs'
import path from 'node:path'
import type {
  PendingResourceIdentityResolution,
  PendingResourceIdentityResolutionResult
} from '@shared/libraryTypes'
import { normalizeVideoCode } from '@shared/videoCode'
import {
  deletePendingResourceIdentity,
  getPendingResourceIdentityRecord,
  selectedPendingResourceIdentityCode
} from '@library/db/pendingResourceIdentityRepo'
import { getDb } from '@library/db/database'
import { getMediaLibraryConfig, getMediaLibraryRoot } from '@library/db/mediaLibraryRepo'
import { upsertPendingScanResources } from '@library/db/pendingScanRepo'
import {
  insertLocalVideoResource,
  insertNewScannedStrmVideo,
  insertNewScannedVideo,
  insertStrmVideoResource,
  listVideosByCode
} from '@library/db/videoRepo'
import { isVideoFile, parseCode } from '@library/scan/codeParser'
import { readLocalVideoDurationSeconds } from '@library/scan/videoDuration'
import { readStrmFile, isStrmFile } from '@library/scan/strmParser'
import { statFileFingerprint } from '../scanner/scanner'
import { authorizeMediaLibraryRootFile } from '@library/scan/mediaLibraryRootFileGuard'
import {
  localNfoScanService,
  type LocalNfoScanService
} from './localNfoScanService'
import type { LocalNfoAnchor } from '../metadata-sources'

export interface PendingResourceIdentityServiceOptions {
  readDurationSeconds?: (filePath: string) => Promise<number | null>
  nfoService?: LocalNfoScanService
}

function directoryCodes(anchorPath: string): Array<string | null> {
  try {
    return fs
      .readdirSync(path.dirname(anchorPath))
      .filter((name) => isVideoFile(name) || isStrmFile(name))
      .map((name) => parseCode(path.basename(name, path.extname(name))))
  } catch {
    return []
  }
}

function assertFingerprint(
  filePath: string,
  expected: { sizeBytes: number | null; fileMtimeMs: number | null }
): ReturnType<typeof statFileFingerprint> {
  const current = statFileFingerprint(filePath)
  if (
    !current ||
    current.file_size !== expected.sizeBytes ||
    current.file_mtime_ms !== expected.fileMtimeMs
  ) {
    throw new Error('源文件已发生变化，请重新扫描后再处理。')
  }
  return current
}

function assertCurrentRecord(libraryId: number, identityId: number, expectedRevision: number) {
  const record = getPendingResourceIdentityRecord(libraryId, identityId)
  if (!record) throw new Error('资源身份待办不存在或已经处理。')
  if (record.revision !== expectedRevision) {
    throw new Error('资源身份待办已发生变化，请刷新后重试。')
  }
  return record
}

export async function resolvePendingResourceIdentity(
  libraryId: number,
  identityId: number,
  resolution: PendingResourceIdentityResolution,
  options: PendingResourceIdentityServiceOptions = {}
): Promise<PendingResourceIdentityResolutionResult> {
  const initial = assertCurrentRecord(libraryId, identityId, resolution.expectedRevision)
  if (resolution.choice === 'discard') {
    deletePendingResourceIdentity(libraryId, identityId, resolution.expectedRevision)
    return { status: 'discarded', warnings: [] }
  }

  const root = getMediaLibraryRoot(libraryId, initial.rootId)
  if (!root || root.state !== 'active') throw new Error('媒体库根目录不可用，请重新扫描。')
  authorizeMediaLibraryRootFile(libraryId, root.id, initial.filePath, root)
  assertFingerprint(initial.filePath, initial)
  const code = selectedPendingResourceIdentityCode(initial, resolution.choice)
  const nfoService = options.nfoService ?? localNfoScanService
  const anchor: LocalNfoAnchor = {
    root,
    anchorPath: initial.filePath,
    directoryVideoCodes: directoryCodes(initial.filePath)
  }
  let inspection
  try {
    inspection = nfoService.inspectIdentity(anchor)
  } catch {
    inspection = {
      status: 'warning' as const,
      code: null,
      warnings: ['当前 NFO 无法安全读取；资源归属仍可继续。']
    }
  }
  let currentNfoMatches = false
  if (inspection.status === 'found' && inspection.code != null) {
    try {
      currentNfoMatches = normalizeVideoCode(inspection.code) === code
    } catch {
      currentNfoMatches = false
    }
  }
  const durationSeconds =
    initial.sourceKind === 'local'
      ? await (options.readDurationSeconds ?? readLocalVideoDurationSeconds)(initial.filePath)
      : null

  authorizeMediaLibraryRootFile(libraryId, root.id, initial.filePath, root)
  const preparedStrm = initial.sourceKind === 'strm' ? readStrmFile(initial.filePath) : null
  if (
    preparedStrm &&
    (preparedStrm.kind !== initial.targetKind || preparedStrm.targetKey !== initial.targetKey)
  ) {
    throw new Error('STRM 目标已发生变化，请重新扫描后再处理。')
  }

  const assignment = getDb().transaction(() => {
    const current = assertCurrentRecord(libraryId, identityId, resolution.expectedRevision)
    authorizeMediaLibraryRootFile(libraryId, root.id, current.filePath, root)
    const fingerprint = assertFingerprint(current.filePath, current)
    const videos = listVideosByCode(code)
    const config = getMediaLibraryConfig(libraryId)
    if (!config) throw new Error('媒体库扫描配置不存在。')

    let result:
      | { status: 'assigned'; videoId: number }
      | { status: 'pending'; pendingGroupId: number }
    if (videos.length > 1 || (videos.length === 1 && !config.autoMergeSameCodeResources)) {
      const pending = upsertPendingScanResources(libraryId, code, [
        {
          rootId: root.id,
          filePath: current.filePath,
          sourceKind: current.sourceKind,
          targetKind: preparedStrm?.kind ?? null,
          targetLocator: preparedStrm?.locator ?? null,
          targetKey: preparedStrm?.targetKey ?? null,
          sizeBytes: fingerprint?.file_size ?? null,
          durationSeconds,
          fileMtimeMs: fingerprint?.file_mtime_ms ?? null,
          displayName: path.basename(current.filePath)
        }
      ])
      result = { status: 'pending', pendingGroupId: pending.groupId }
    } else if (videos.length === 1) {
      const videoId = videos[0].id
      const resourceId = preparedStrm
        ? insertStrmVideoResource({
            libraryId,
            videoId,
            rootId: root.id,
            sourcePath: current.filePath,
            kind: preparedStrm.kind,
            locator: preparedStrm.locator,
            displayName: path.basename(current.filePath)
          })
        : insertLocalVideoResource({
            libraryId,
            videoId,
            rootId: root.id,
            locator: current.filePath,
            sizeBytes: fingerprint?.file_size ?? null,
            durationSeconds,
            fileMtimeMs: fingerprint?.file_mtime_ms ?? null
          })
      if (resourceId == null) throw new Error('资源已经归属或无法写入。')
      result = { status: 'assigned', videoId }
    } else {
      const videoId = preparedStrm
        ? insertNewScannedStrmVideo({
            libraryId,
            rootId: root.id,
            code,
            sourcePath: current.filePath,
            kind: preparedStrm.kind,
            locator: preparedStrm.locator,
            displayName: path.basename(current.filePath)
          })
        : insertNewScannedVideo({
            libraryId,
            rootId: root.id,
            code,
            locator: current.filePath,
            size_bytes: fingerprint?.file_size ?? null,
            duration_seconds: durationSeconds,
            file_mtime_ms: fingerprint?.file_mtime_ms ?? null
          })
      if (videoId == null) throw new Error('资源已经归属或无法写入。')
      result = { status: 'assigned', videoId }
    }
    if (!deletePendingResourceIdentity(libraryId, identityId, resolution.expectedRevision)) {
      throw new Error('资源身份待办不存在或已经处理。')
    }
    return result
  }).immediate()

  const warnings = [...inspection.warnings]
  if (assignment.status === 'pending') {
    warnings.push('资源已进入归属待确认；完成归属后可手动导入本地 NFO。')
    return { ...assignment, warnings }
  }
  if (!currentNfoMatches) {
    warnings.push('当前 NFO 已缺失、不可用或番号已变化；资源归属已完成，但未应用 NFO 元数据。')
    return { ...assignment, warnings }
  }
  try {
    const applied = await nfoService.apply(assignment.videoId, code, [anchor])
    return { ...assignment, warnings: [...warnings, ...applied.warnings] }
  } catch {
    return {
      ...assignment,
      warnings: [...warnings, '资源归属已完成，但 NFO 元数据应用失败。']
    }
  }
}
