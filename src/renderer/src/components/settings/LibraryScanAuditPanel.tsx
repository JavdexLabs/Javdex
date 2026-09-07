import { useEffect, useMemo, useRef, useState } from 'react'
import { FixedSizeList, type ListChildComponentProps } from 'react-window'
import type {
  LibraryScanAudit,
  LibraryScanFileAuditEntry,
  LibraryScanMetricKey,
  LibraryScanResourceAuditEntry,
  LibraryScanSummary,
  LibraryScanLatestSnapshot
} from '@shared/libraryTypes'
import { Copy, FolderOpen, AlertTriangle, CheckCircle2, RefreshCw, FileText, Trash2 } from 'lucide-react'
import Button from '../Button'
import IconButton from '../IconButton'
import SelectControl from '../SelectControl'
import { SettingsEmptyPanel, SettingsStatusPill } from './SettingsPrimitives'
import UnrecognizedRow from './UnrecognizedRow'
import { api } from '../../api'
import { pendingItemKey, type PendingItemKey } from '../../listView/pendingRoutes'
import { useToast } from '../Toast'
import styles from './LibraryScanAuditPanel.module.css'
import {
  auditRowHeight,
  isCompactAuditRow,
  shouldVirtualizeAuditRows,
  type ScanAuditTab
} from './libraryScanAuditLayout'

const OUTCOME_LABEL: Record<LibraryScanFileAuditEntry['outcome'], string> = {
  added: '新增',
  updated: '更新',
  pending: '待确认',
  skipped: '跳过',
  unrecognized: '无法识别',
  strm_failure: 'STRM 失败',
  processing_failure: '处理失败'
}

type ViewItem = {
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
  pendingTarget?: PendingItemKey
  isUnrecognizedPending?: boolean
}

function auditItemAnchor(item: ViewItem): string {
  if (item.groupId) return `group:${item.groupId}`
  if (item.path) return `path:${encodeURIComponent(item.path)}`
  return `item:${encodeURIComponent(item.key)}`
}

function fileDetail(entry: LibraryScanFileAuditEntry): string {
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

function fileView(entry: LibraryScanFileAuditEntry, index: number): ViewItem {
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

function isAttentionFile(entry: LibraryScanFileAuditEntry): boolean {
  return (
    ['unrecognized', 'strm_failure', 'processing_failure'].includes(entry.outcome) ||
    entry.nfo?.disposition === 'warning' ||
    entry.nfo?.disposition === 'identity-conflict' ||
    entry.nfo?.disposition === 'pending-candidate'
  )
}

function isCurrentNfoPending(
  entry: LibraryScanFileAuditEntry,
  currentPendingIdentityIds: ReadonlySet<number>,
  currentPendingScrapeIds: ReadonlySet<number>
): boolean {
  if (entry.nfo?.disposition === 'identity-conflict') {
    return (
      entry.nfo.pendingIdentityId != null &&
      currentPendingIdentityIds.has(entry.nfo.pendingIdentityId)
    )
  }
  if (entry.nfo?.disposition === 'pending-candidate') {
    return (
      entry.nfo.pendingScrapeId != null &&
      currentPendingScrapeIds.has(entry.nfo.pendingScrapeId)
    )
  }
  return false
}

function resourceView(entry: LibraryScanResourceAuditEntry, index: number): ViewItem {
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

function getOutcomeClass(outcome?: LibraryScanFileAuditEntry['outcome']): string {
  switch (outcome) {
    case 'added':
      return styles.outcomeAdded
    case 'updated':
      return styles.outcomeUpdated
    case 'pending':
      return styles.outcomePending
    case 'unrecognized':
    case 'strm_failure':
    case 'processing_failure':
      return styles.outcomeFailed
    default:
      return ''
  }
}

function AuditRowContent({
  libraryId,
  item,
  style,
  activeTab,
  onOpenAttention,
  onOpenPending,
  onResolvedUnrecognized
}: {
  libraryId: number
  item: ViewItem
  style?: React.CSSProperties
  activeTab: ScanAuditTab
  onOpenAttention: (item: ViewItem) => void
  onOpenPending: (target: PendingItemKey) => void
  onResolvedUnrecognized: (path: string) => void
}): JSX.Element {
  const toast = useToast()

  if (item.isUnrecognizedPending && item.path && item.rootId) {
    return (
      <div
        className={styles.rowSlot}
        style={style}
        data-audit-anchor={auditItemAnchor(item)}
        tabIndex={-1}
      >
        <UnrecognizedRow
          libraryId={libraryId}
          rootId={item.rootId}
          path={item.path}
          onResolved={onResolvedUnrecognized}
        />
      </div>
    )
  }

  const copyPath = async (): Promise<void> => {
    if (!item.path) return
    await navigator.clipboard.writeText(item.path)
    toast.show('路径已复制', 'success')
  }

  const reveal = async (): Promise<void> => {
    if (!item.path) return
    const result = await api.scan.revealAuditFile(libraryId, item.path)
    if (!result.ok) {
      toast.show(result.fileMissing ? '文件已不存在' : result.error || '无法打开目录', 'error')
    }
  }

  const isSkipped = isCompactAuditRow(activeTab, item.outcome)

  return (
    <div
      className={styles.rowSlot}
      style={style}
      data-audit-anchor={auditItemAnchor(item)}
      tabIndex={-1}
    >
      <div className={`${styles.row}${isSkipped ? ` ${styles.skippedRow}` : ''}`}>
        <div className={styles.rowCopy}>
          <div className={styles.rowTitleRow}>
            {item.outcome ? (
              <span className={`${styles.rowOutcomeTag} ${getOutcomeClass(item.outcome)}`}>
                {OUTCOME_LABEL[item.outcome]}
              </span>
            ) : null}
            <strong className={styles.rowTitle} title={item.title}>
              {item.title}
            </strong>
            {item.status ? (
              <span
                className={`${styles.rowStateTag}${item.status === '待处理' ? ` ${styles.rowStateWarning}` : ''}`}
              >
                {item.status}
              </span>
            ) : null}
          </div>
          <span className={styles.rowSubtitle} title={item.detail}>
            {item.detail}
          </span>
        </div>
        <div className={styles.rowActions}>
          {activeTab === 'all' && item.requiresAttention ? (
            <Button type="button" size="sm" onClick={() => onOpenAttention(item)}>
              处理
            </Button>
          ) : item.videoId ? (
            <Button type="button" size="sm" data-video-id={item.videoId}>
              查看影片
            </Button>
          ) : null}
          {activeTab !== 'all' && item.pendingTarget ? (
            <Button
              type="button"
              size="sm"
              onClick={() => onOpenPending(item.pendingTarget!)}
            >
              处理待办
            </Button>
          ) : null}
          {item.path ? (
            <>
              <IconButton
                size="sm"
                className={styles.rowIconButton}
                icon={<Copy size={13} aria-hidden />}
                label="复制完整路径"
                onClick={() => void copyPath()}
              />
              <IconButton
                size="sm"
                className={styles.rowIconButton}
                icon={<FolderOpen size={13} aria-hidden />}
                label="在文件夹中显示"
                onClick={() => void reveal()}
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function AuditRow({
  index,
  style,
  data
}: ListChildComponentProps<{
  libraryId: number
  items: ViewItem[]
  activeTab: ScanAuditTab
  onOpenAttention: (item: ViewItem) => void
  onOpenPending: (target: PendingItemKey) => void
  onResolvedUnrecognized: (path: string) => void
}>): JSX.Element {
  return (
    <AuditRowContent
      libraryId={data.libraryId}
      item={data.items[index]}
      style={style}
      activeTab={data.activeTab}
      onOpenAttention={data.onOpenAttention}
      onOpenPending={data.onOpenPending}
      onResolvedUnrecognized={data.onResolvedUnrecognized}
    />
  )
}

export default function LibraryScanAuditPanel({
  summary,
  audit,
  selected,
  unrecognized,
  currentPendingGroupIds,
  currentPendingIdentityIds,
  currentPendingScrapeIds,
  onSelect,
  onResolvedUnrecognized,
  onOpenVideo,
  onOpenPending
}: {
  summary: LibraryScanSummary
  audit: LibraryScanAudit | null
  selected: LibraryScanMetricKey | null
  unrecognized: LibraryScanLatestSnapshot['unrecognized']
  currentPendingGroupIds: Set<number>
  currentPendingIdentityIds: Set<number>
  currentPendingScrapeIds: Set<number>
  onSelect: (key: LibraryScanMetricKey | null) => void
  onResolvedUnrecognized: (path: string) => void
  onOpenVideo: (videoId: number) => void
  onOpenPending: (target: PendingItemKey) => void
}): JSX.Element {
  const [activeTab, setActiveTab] = useState<ScanAuditTab>('failed')
  const [search, setSearch] = useState('')
  const [outcome, setOutcome] = useState<LibraryScanFileAuditEntry['outcome'] | 'all'>('all')
  const [changesFilter, setChangesFilter] = useState<'all' | 'removed' | 'promoted' | 'deleted'>('all')
  const [attentionTarget, setAttentionTarget] = useState<string | null>(null)
  const listContainerRef = useRef<HTMLDivElement | null>(null)
  const virtualListRef = useRef<FixedSizeList | null>(null)

  const matchedAudit =
    audit?.libraryId === summary.libraryId &&
    audit.runId === summary.runId &&
    audit.finishedAt === summary.finishedAt
      ? audit
      : null
  const cachedUnrecognizedPaths = useMemo(
    () => new Set(unrecognized.map((item) => item.filePath)),
    [unrecognized]
  )
  const auditedUnrecognizedPaths = useMemo(
    () =>
      new Set(
        matchedAudit?.files
          .filter((entry) => entry.outcome === 'unrecognized')
          .map((entry) => entry.filePath) ?? []
      ),
    [matchedAudit]
  )
  const extraCachedUnrecognizedCount = unrecognized.filter(
    (item, index) =>
      unrecognized.findIndex((candidate) => candidate.filePath === item.filePath) === index &&
      !auditedUnrecognizedPaths.has(item.filePath)
  ).length

  const totalFailed =
    (matchedAudit?.files.filter(isAttentionFile).length ?? 0) +
    (matchedAudit?.pendingGroups.length ?? 0) +
    extraCachedUnrecognizedCount
  const totalAddedUpdated = summary.resourcesAdded + summary.resourcesUpdated
  const totalChanges =
    summary.resourcesRemoved + summary.primaryResourcesPromoted + summary.videosDeleted

  // Sync external selected metric key to corresponding tab if changed
  useEffect(() => {
    if (!selected) return
    if (selected === 'failedFiles' || selected === 'pendingScanGroups' || selected === 'pendingScanResources') {
      setActiveTab('failed')
    } else if (selected === 'scannedFiles') {
      setActiveTab('all')
    } else if (selected === 'resourcesAdded' || selected === 'resourcesUpdated') {
      setActiveTab('added_updated')
    } else if (selected === 'skippedFiles') {
      setActiveTab('skipped')
    } else if (
      selected === 'resourcesRemoved' ||
      selected === 'primaryResourcesPromoted' ||
      selected === 'videosDeleted'
    ) {
      setActiveTab('changes')
    }
  }, [selected])

  useEffect(() => {
    setActiveTab('failed')
    setSearch('')
    setOutcome('all')
    setChangesFilter('all')
    onSelect('failedFiles')
  }, [onSelect, summary.libraryId, summary.runId])

  const items = useMemo((): ViewItem[] => {
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
          const pending = isCurrentNfoPending(
            entry,
            currentPendingIdentityIds,
            currentPendingScrapeIds
          )
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
        groupId: currentPendingGroupIds.has(entry.groupId) ? entry.groupId : undefined,
        pendingTarget: currentPendingGroupIds.has(entry.groupId)
          ? pendingItemKey('scan', entry.groupId)
          : undefined,
        status: currentPendingGroupIds.has(entry.groupId) ? '待处理' : '已处理',
        requiresAttention: currentPendingGroupIds.has(entry.groupId)
      }))

      // Unrecognized files that might not be in file list (e.g. persistent across scans)
      const listedPaths = new Set(failedFileEntries.map((f) => f.filePath))
      const extraUnrecItems: ViewItem[] = unrecognized
        .filter(
          (item, index) =>
            unrecognized.findIndex((candidate) => candidate.filePath === item.filePath) === index &&
            !listedPaths.has(item.filePath)
        )
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
        const pending = isCurrentNfoPending(
          entry,
          currentPendingIdentityIds,
          currentPendingScrapeIds
        )
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
          entry.groupId != null && currentPendingGroupIds.has(entry.groupId)
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
  }, [
    activeTab,
    cachedUnrecognizedPaths,
    changesFilter,
    currentPendingGroupIds,
    currentPendingIdentityIds,
    currentPendingScrapeIds,
    matchedAudit,
    outcome,
    unrecognized
  ])

  const filtered = useMemo(() => {
    const query = activeTab === 'all' ? search.trim().toLocaleLowerCase() : ''
    return query
      ? items.filter((item) =>
          `${item.title} ${item.detail} ${item.path ?? ''}`.toLocaleLowerCase().includes(query)
        )
      : items
  }, [activeTab, items, search])

  const rowHeight = auditRowHeight(activeTab)
  const shouldVirtualize = shouldVirtualizeAuditRows(activeTab, filtered.length)

  useEffect(() => {
    virtualListRef.current?.scrollTo(0)
  }, [activeTab, changesFilter, outcome, search, summary.finishedAt])

  useEffect(() => {
    if (activeTab !== 'failed' || !attentionTarget) return
    const frame = window.requestAnimationFrame(() => {
      const target = listContainerRef.current?.querySelector<HTMLElement>(
        `[data-audit-anchor="${attentionTarget}"]`
      )
      target?.scrollIntoView({ block: 'center' })
      target?.focus({ preventScroll: true })
      setAttentionTarget(null)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeTab, attentionTarget, filtered])

  const handleTabChange = (tab: ScanAuditTab): void => {
    setActiveTab(tab)
    if (tab === 'failed') onSelect('failedFiles')
    else if (tab === 'all') onSelect('scannedFiles')
    else if (tab === 'added_updated') onSelect('resourcesAdded')
    else if (tab === 'skipped') onSelect('skippedFiles')
    else if (tab === 'changes') onSelect('resourcesRemoved')
  }

  const handleOpenAttention = (item: ViewItem): void => {
    setAttentionTarget(auditItemAnchor(item))
    handleTabChange('failed')
  }

  return (
    <div className={styles.root}>
      {/* 结构化 Tab 导航 */}
      <nav className={styles.tabsNav} aria-label="扫描审计分类">
        <button
          type="button"
          className={`${styles.tabBtn}${activeTab === 'failed' ? ` ${styles.tabBtnActive}` : ''}`}
          onClick={() => handleTabChange('failed')}
        >
          <AlertTriangle size={13} aria-hidden />
          <span>异常与待办</span>
          <span
            className={`${styles.tabBadge}${totalFailed > 0 ? ` ${styles.tabBadgeWarning}` : ''}`}
          >
            {totalFailed}
          </span>
        </button>

        <button
          type="button"
          className={`${styles.tabBtn}${activeTab === 'all' ? ` ${styles.tabBtnActive}` : ''}`}
          onClick={() => handleTabChange('all')}
        >
          <FileText size={13} aria-hidden />
          <span>全部文件</span>
          <span className={styles.tabBadge}>{summary.scannedFiles}</span>
        </button>

        <button
          type="button"
          className={`${styles.tabBtn}${activeTab === 'added_updated' ? ` ${styles.tabBtnActive}` : ''}`}
          onClick={() => handleTabChange('added_updated')}
        >
          <CheckCircle2 size={13} aria-hidden />
          <span>新增与更新</span>
          <span className={styles.tabBadge}>{totalAddedUpdated}</span>
        </button>

        <button
          type="button"
          className={`${styles.tabBtn}${activeTab === 'skipped' ? ` ${styles.tabBtnActive}` : ''}`}
          onClick={() => handleTabChange('skipped')}
        >
          <RefreshCw size={13} aria-hidden />
          <span>已跳过</span>
          <span className={styles.tabBadge}>{summary.skippedFiles}</span>
        </button>

        <button
          type="button"
          className={`${styles.tabBtn}${activeTab === 'changes' ? ` ${styles.tabBtnActive}` : ''}`}
          onClick={() => handleTabChange('changes')}
        >
          <Trash2 size={13} aria-hidden />
          <span>资源清理</span>
          <span className={styles.tabBadge}>{totalChanges}</span>
        </button>
      </nav>

      {/* 详情明细卡片 */}
      <section className={styles.detail} aria-label="扫描审计明细">
        <div className={styles.detailHead}>
          <div>
            <strong className={styles.detailTitle}>
              {activeTab === 'failed' && '异常与待办清单'}
              {activeTab === 'all' && '全部已扫描文件'}
              {activeTab === 'added_updated' && '本次新增与更新的资源'}
              {activeTab === 'skipped' && '已跳过处理的文件'}
              {activeTab === 'changes' && '资源移除、提升与移出记录'}
            </strong>
            <span className={styles.detailDesc}>
              {activeTab === 'failed' && '包含无法识别、STRM 解析失败、处理失败及待确认归属项。'}
              {activeTab === 'all' && '包含本次扫描涉及的所有文件及最终处理结果。'}
              {activeTab === 'added_updated' && '已成功新建影片或挂载到已有影片的资源。'}
              {activeTab === 'skipped' && '未发生变更、低于最短时长限制或重复的文件。'}
              {activeTab === 'changes' && '源文件缺失清理、主资源替补提升及无资源成员移出。'}
            </span>
          </div>
          <SettingsStatusPill status="muted">{filtered.length} 项</SettingsStatusPill>
        </div>

        {/* 资源清理分类下的子标签 */}
        {activeTab === 'changes' ? (
          <div className={styles.subFilters}>
            <button
              type="button"
              className={`${styles.subFilterChip}${changesFilter === 'all' ? ` ${styles.subFilterChipActive}` : ''}`}
              onClick={() => setChangesFilter('all')}
            >
              全部 ({totalChanges})
            </button>
            <button
              type="button"
              className={`${styles.subFilterChip}${changesFilter === 'removed' ? ` ${styles.subFilterChipActive}` : ''}`}
              onClick={() => setChangesFilter('removed')}
            >
              移除资源 ({summary.resourcesRemoved})
            </button>
            <button
              type="button"
              className={`${styles.subFilterChip}${changesFilter === 'promoted' ? ` ${styles.subFilterChipActive}` : ''}`}
              onClick={() => setChangesFilter('promoted')}
            >
              提升主资源 ({summary.primaryResourcesPromoted})
            </button>
            <button
              type="button"
              className={`${styles.subFilterChip}${changesFilter === 'deleted' ? ` ${styles.subFilterChipActive}` : ''}`}
              onClick={() => setChangesFilter('deleted')}
            >
              移出无资源成员 ({summary.videosDeleted})
            </button>
          </div>
        ) : null}

        {matchedAudit || (activeTab === 'failed' && unrecognized.length > 0) ? (
          <>
            {activeTab === 'all' ? (
              <div className={styles.toolbar}>
                <input
                  className="text-input"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索番号、文件名或路径…"
                  aria-label="搜索扫描明细"
                />
                <SelectControl
                  value={outcome}
                  onChange={(event) => setOutcome(event.target.value as typeof outcome)}
                  aria-label="筛选扫描结果"
                >
                  <option value="all">全部结果</option>
                  {Object.entries(OUTCOME_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </SelectControl>
              </div>
            ) : null}

            {filtered.length > 0 ? (
              <div
                ref={listContainerRef}
                className={styles.list}
                onClick={(event) => {
                  const target = (event.target as HTMLElement).closest<HTMLElement>(
                    '[data-video-id]'
                  )
                  if (!target) return
                  const videoId = Number(target.dataset.videoId)
                  if (Number.isInteger(videoId) && videoId > 0) onOpenVideo(videoId)
                }}
              >
                {shouldVirtualize ? (
                  <FixedSizeList
                    ref={virtualListRef}
                    className={styles.virtualList}
                    height={Math.min(480, filtered.length * rowHeight)}
                    width="100%"
                    itemCount={filtered.length}
                    itemSize={rowHeight}
                    itemData={{
                      libraryId: summary.libraryId,
                      items: filtered,
                      activeTab,
                      onOpenAttention: handleOpenAttention,
                      onOpenPending,
                      onResolvedUnrecognized
                    }}
                  >
                    {AuditRow}
                  </FixedSizeList>
                ) : (
                  filtered.map((item) => (
                    <AuditRowContent
                      key={item.key}
                      libraryId={summary.libraryId}
                      item={item}
                      activeTab={activeTab}
                      onOpenAttention={handleOpenAttention}
                      onOpenPending={onOpenPending}
                      onResolvedUnrecognized={onResolvedUnrecognized}
                    />
                  ))
                )}
              </div>
            ) : (
              <SettingsEmptyPanel variant="compact">没有符合条件的明细</SettingsEmptyPanel>
            )}
          </>
        ) : (
          <SettingsEmptyPanel variant="compact">
            此扫描仅保留了摘要，下一次扫描后会生成完整明细。
          </SettingsEmptyPanel>
        )}
      </section>
    </div>
  )
}
