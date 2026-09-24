import type { LibraryScanAudit, LibraryScanLatestSnapshot, LibraryScanFileAuditEntry, LibraryScanResourceAuditEntry } from './libraryTypes'

/** Structural pending target; routing and live status enrichment remain with the caller. */
export interface ScanAuditPendingTarget {
  domain: 'scan' | 'scrape' | 'actress'
  id: string
}

export type ViewItem = {
  key: string
  title: string
  detail: string
  outcome?: LibraryScanFileAuditEntry['outcome']
  path?: string
  rootId?: number
  videoId?: number
  groupId?: number
  status?: string
  requiresAttention?: boolean
  pendingTarget?: ScanAuditPendingTarget
  isUnrecognizedPending?: boolean
}

export function fileDetail(entry: LibraryScanFileAuditEntry): string {
  const primary = (() => {
    switch (entry.outcome) {
      case 'added':
        return entry.createdVideo ? '新建影片并添加资源' : '挂载到已有影片'
      case 'updated':
        return {
          relocated: '路径已重定位',
          metadata_refreshed: '文件信息已刷新',
          strm_target_synced: 'STRM 目标已同步'
        }[entry.updateKind]
      case 'pending':
        return `${entry.normalizedCode || '番号未知'} · ${
          entry.sourceKind === 'strm' ? 'STRM' : '本地文件'
        } · ${entry.addedToQueue ? '已加入待确认队列' : '仍在待确认队列'}`
      case 'skipped':
        return {
          unchanged: '未变化',
          below_min_duration: '低于最短时长',
          duplicate: '重复资源'
        }[entry.skipReason]
      case 'unrecognized':
        return '文件名未识别出番号'
      case 'strm_failure':
        return entry.message
      case 'processing_failure':
        return entry.message
    }
  })()
  if (!entry.nfo) return primary
  const nfoLabel = {
    imported: 'NFO 已导入',
    skipped: 'NFO 已跳过',
    warning: 'NFO 警告',
    'pending-candidate': 'NFO 候选待确认',
    'identity-conflict': 'NFO 身份冲突'
  }[entry.nfo.disposition]
  const warnings = entry.nfo.warnings?.map((warning) => warning.message).join('；')
  return `${primary} · ${nfoLabel}${warnings ? ` · ${warnings}` : ''}`
}

export function fileView(entry: LibraryScanFileAuditEntry, index: number): ViewItem {
  return {
    key: `file:${index}:${entry.filePath}`,
    title: entry.filePath.split(/[\\/]/).pop() || entry.filePath,
    detail: fileDetail(entry),
    outcome: entry.outcome,
    path: entry.filePath,
    rootId: entry.rootId,
    videoId: 'videoId' in entry ? entry.videoId : undefined,
    groupId: entry.outcome === 'pending' ? entry.groupId ?? undefined : undefined
  }
}

export function isAttentionFile(entry: LibraryScanFileAuditEntry): boolean {
  return (
    ['unrecognized', 'strm_failure', 'processing_failure'].includes(entry.outcome) ||
    entry.nfo?.disposition === 'warning' ||
    entry.nfo?.disposition === 'identity-conflict' ||
    entry.nfo?.disposition === 'pending-candidate'
  )
}

export function hasNfoPendingTarget(
  entry: LibraryScanFileAuditEntry
): boolean {
  if (entry.nfo?.disposition === 'identity-conflict') {
    return (
      entry.nfo.pendingIdentityId != null
    )
  }
  if (entry.nfo?.disposition === 'pending-candidate') {
    return (
      entry.nfo.pendingScrapeId != null
    )
  }
  return false
}

export function resourceView(entry: LibraryScanResourceAuditEntry, index: number): ViewItem {
  const reason = {
    missing: '源文件缺失',
    removed_library_path: '媒体库路径已移除',
    promoted_after_removal: '原主资源移除后提升'
  }[entry.reason]
  return {
    key: `resource:${index}:${entry.resourceId}`,
    title: `${entry.videoCode}${entry.videoTitle ? ` · ${entry.videoTitle}` : ''}`,
    detail: `${entry.resourceKind.toUpperCase()} · ${reason} · ${
      entry.displayName || entry.sourcePath || '外部目标已隐藏'
    }`,
    path: entry.sourcePath ?? undefined,
    videoId: entry.videoId
  }
}

export interface ScanAuditViewItemsInput {
  audit: LibraryScanAudit | null
  unrecognized: LibraryScanLatestSnapshot['unrecognized']
  activeTab: 'failed' | 'all' | 'added_updated' | 'skipped' | 'changes'
  changesFilter: 'all' | 'removed' | 'promoted' | 'deleted'
  outcome: LibraryScanFileAuditEntry['outcome'] | 'all'
}

function pendingItemKey(domain: ScanAuditPendingTarget['domain'], id: string | number): ScanAuditPendingTarget {
  return { domain, id: String(id) }
}

/** Build historical rows only; search, paging and live pending presence belong to the caller. */
export function buildScanAuditViewItems({
  audit: matchedAudit,
  unrecognized,
  activeTab,
  changesFilter,
  outcome
}: ScanAuditViewItemsInput): ViewItem[] {
  const seen = new Set<string>()
  const uniqueUnrecognized = unrecognized.filter(item => {
    if (seen.has(item.filePath)) return false
    seen.add(item.filePath)
    return true
  })
  const cachedUnrecognizedPaths = new Set(unrecognized.map(item => item.filePath))
  if (activeTab === 'failed') {
    const failedFileEntries =
      matchedAudit?.files.filter(isAttentionFile) ?? []
    const fileItems: ViewItem[] = failedFileEntries.map((entry, index) => {
      const item = fileView(entry, index)
      if (entry.outcome === 'unrecognized') {
        const isPending = cachedUnrecognizedPaths.has(entry.filePath)
        item.isUnrecognizedPending = isPending
        item.status = isPending ? '待处理' : '已处理'
        item.requiresAttention = isPending
      }
      if (
        entry.nfo?.disposition === 'identity-conflict' ||
        entry.nfo?.disposition === 'pending-candidate'
      ) {
        const pending = hasNfoPendingTarget(entry)
        item.status = pending ? '待处理' : '已处理'
        item.requiresAttention = pending
        if (pending) {
          item.pendingTarget =
            entry.nfo.disposition === 'identity-conflict'
              ? pendingItemKey('scan', `identity-${entry.nfo.pendingIdentityId}`)
              : pendingItemKey('scrape', entry.nfo.pendingScrapeId!)
        }
      }
      return item
    })

    const groupItems: ViewItem[] = (matchedAudit?.pendingGroups ?? []).map((entry) => ({
      key: `pending-group:${entry.groupId}`,
      title: `待确认归属 · ${entry.normalizedCode}`,
      detail: `${entry.resourceCount} 个扫描资源`,
      groupId: entry.groupId,
      pendingTarget: pendingItemKey('scan', entry.groupId),
      status: '待处理',
      requiresAttention: true
    }))

    // Unrecognized files that might not be in file list (e.g. persistent across scans)
    const listedPaths = new Set(failedFileEntries.map((f) => f.filePath))
    const extraUnrecItems: ViewItem[] = uniqueUnrecognized
      .filter(item => !listedPaths.has(item.filePath))
      .map((item, idx) => ({
        key: `extra-unrec:${idx}:${item.filePath}`,
        title: item.filePath.split(/[\\/]/).pop() || item.filePath,
        detail: '未识别番号文件',
        outcome: 'unrecognized',
        path: item.filePath,
        rootId: item.rootId,
        isUnrecognizedPending: true,
        status: '待处理',
        requiresAttention: true
      }))

    return [...extraUnrecItems, ...fileItems, ...groupItems]
  }

  if (!matchedAudit) return []

  if (activeTab === 'added_updated') {
    return matchedAudit.files
      .filter((entry) => entry.outcome === 'added' || entry.outcome === 'updated')
      .map(fileView)
  }

  if (activeTab === 'skipped') {
    return matchedAudit.files
      .filter((entry) => entry.outcome === 'skipped')
      .map(fileView)
  }

  if (activeTab === 'changes') {
    const deletedVideoIds = new Set(matchedAudit.deletedVideos.map((entry) => entry.videoId))
    const removed = matchedAudit.removedResources.map((entry, index) => {
      const item = resourceView(entry, index)
      if (deletedVideoIds.has(entry.videoId)) item.videoId = undefined
      return item
    })
    const promoted = matchedAudit.promotedResources.map(resourceView)
    const deleted: ViewItem[] = matchedAudit.deletedVideos.map((entry, index) => ({
      key: `deleted:${index}:${entry.videoId}`,
      title: `${entry.videoCode}${entry.videoTitle ? ` · ${entry.videoTitle}` : ''}`,
      detail: '扫描后移出的无资源成员'
    }))

    if (changesFilter === 'removed') return removed
    if (changesFilter === 'promoted') return promoted
    if (changesFilter === 'deleted') return deleted
    return [...removed, ...promoted, ...deleted]
  }

  // Default 'all'
  let allFiles = matchedAudit.files
  if (outcome !== 'all') {
    allFiles = allFiles.filter((entry) => entry.outcome === outcome)
  }
  return allFiles.map((entry, index) => {
    const item = fileView(entry, index)
    if (
      entry.nfo?.disposition === 'identity-conflict' ||
      entry.nfo?.disposition === 'pending-candidate'
    ) {
      const pending = hasNfoPendingTarget(entry)
      item.status = pending ? '待处理' : '已处理'
      item.requiresAttention = pending
      if (pending) {
        item.pendingTarget =
          entry.nfo.disposition === 'identity-conflict'
            ? pendingItemKey('scan', `identity-${entry.nfo.pendingIdentityId}`)
            : pendingItemKey('scrape', entry.nfo.pendingScrapeId!)
      }
      if (!pending) item.groupId = undefined
    } else if (entry.outcome === 'pending') {
      const pending =
        entry.groupId != null
      item.status = pending ? '待处理' : '已处理'
      item.requiresAttention = pending
      if (pending) item.pendingTarget = pendingItemKey('scan', entry.groupId!)
      if (!pending) item.groupId = undefined
    } else if (entry.outcome === 'unrecognized') {
      const pending = cachedUnrecognizedPaths.has(entry.filePath)
      item.status = pending ? '待处理' : '已处理'
      item.requiresAttention = pending
    }
    return item
  })
}
