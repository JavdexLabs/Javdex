import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FixedSizeList, type ListChildComponentProps } from 'react-window'
import type {
  LibraryScanAudit,
  LibraryScanFileAuditEntry,
  LibraryScanMetricKey,
  LibraryScanSummary,
  LibraryScanLatestSnapshot
} from '@shared/libraryTypes'
import {
  fileView,
  isAttentionFile,
  hasNfoPendingTarget,
  resourceView,
  type ViewItem
} from '@shared/scanAuditView'
import { Copy, FolderOpen, AlertTriangle, CheckCircle2, RefreshCw, FileText, Trash2 } from 'lucide-react'
import Button from '../Button'
import IconButton from '../IconButton'
import SelectControl from '../SelectControl'
import { SettingsEmptyPanel, SettingsStatusPill } from './SettingsPrimitives'
import UnrecognizedRow from './UnrecognizedRow'
import { api } from '../../api'
import { usePendingAuditPresence } from '../../hooks/usePendingAuditPresence'
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

function auditItemAnchor(item: ViewItem): string {
  if (item.groupId) return `group:${item.groupId}`
  if (item.path) return `path:${encodeURIComponent(item.path)}`
  return `item:${encodeURIComponent(item.key)}`
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
  onSelect,
  onResolvedUnrecognized,
  onOpenVideo,
  onOpenPending
}: {
  summary: LibraryScanSummary
  audit: LibraryScanAudit | null
  selected: LibraryScanMetricKey | null
  unrecognized: LibraryScanLatestSnapshot['unrecognized']
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
  const uniqueUnrecognized = useMemo(() => {
    const seen = new Set<string>()
    return unrecognized.filter(item => {
      if (seen.has(item.filePath)) return false
      seen.add(item.filePath)
      return true
    })
  }, [unrecognized])
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
  const extraCachedUnrecognizedCount = uniqueUnrecognized.filter(item => !auditedUnrecognizedPaths.has(item.filePath)).length

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
  }, [
    activeTab,
    cachedUnrecognizedPaths,
    changesFilter,
          matchedAudit,
    outcome,
    uniqueUnrecognized
  ])

  const filtered = useMemo(() => {
    const query = activeTab === 'all' ? search.trim().toLocaleLowerCase() : ''
    return query
      ? items.filter((item) =>
          `${item.title} ${item.detail} ${item.path ?? ''}`.toLocaleLowerCase().includes(query)
        )
      : items
  }, [activeTab, items, search])

  const pageScope = JSON.stringify([summary.libraryId,summary.runId,summary.finishedAt,activeTab,search,outcome,changesFilter])
  const [pageState, setPageState] = useState({scope:'',index:0})
  const pageIndex = Math.min(pageState.scope === pageScope ? pageState.index : 0, Math.max(0,Math.ceil(filtered.length/100)-1))
  const setPage = useCallback((index:number) => setPageState({scope:pageScope,index}),[pageScope])
  const pageItems = filtered.slice(pageIndex*100,(pageIndex+1)*100)
  const targets = {groupIds:[] as number[],identityIds:[] as number[],scrapeIds:[] as number[]}
  for (const item of pageItems) {
    const target=item.pendingTarget
    if (!target) continue
    if (target.domain==='scrape') targets.scrapeIds.push(Number(target.id))
    else if (target.id.startsWith('identity-')) targets.identityIds.push(Number(target.id.slice('identity-'.length)))
    else targets.groupIds.push(Number(target.id))
  }
  const presence = usePendingAuditPresence(summary.libraryId, targets, pageScope)
  const displayedItems = pageItems.map(item => {
    if (!item.pendingTarget) return item
    const known = presence.state === 'ready'
    const pending = known && presence.ids.has(`${item.pendingTarget.domain}:${item.pendingTarget.id}`)
    return { ...item, status: !known ? presence.state === 'error' ? '状态未知' : '读取中…' : pending ? '待处理' : '已处理',
      requiresAttention: pending, pendingTarget: pending ? item.pendingTarget : undefined }
  })

  const rowHeight = auditRowHeight(activeTab)
  const shouldVirtualize = shouldVirtualizeAuditRows(activeTab, displayedItems.length)

  useEffect(() => {
    virtualListRef.current?.scrollTo(0)
  }, [activeTab, changesFilter, outcome, search, summary.finishedAt, pageIndex])

  useEffect(() => {
    if (activeTab !== 'failed' || !attentionTarget) return
    const targetIndex = filtered.findIndex(item => auditItemAnchor(item) === attentionTarget)
    if (targetIndex >= 0 && Math.floor(targetIndex / 100) !== pageIndex) { setPage(Math.floor(targetIndex / 100)); return }
    const frame = window.requestAnimationFrame(() => {
      const target = listContainerRef.current?.querySelector<HTMLElement>(
        `[data-audit-anchor="${attentionTarget}"]`
      )
      target?.scrollIntoView({ block: 'center' })
      target?.focus({ preventScroll: true })
      setAttentionTarget(null)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeTab, attentionTarget, filtered, pageIndex, setPage])

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

        {presence.state === 'error' ? <div role="status" className={styles.subFilters}>
          <span>待办状态读取失败</span><Button size="sm" onClick={presence.retry}>重试状态</Button>
        </div> : null}
        {filtered.length > 100 ? <nav aria-label="扫描审计分页" className={styles.subFilters}>
          <Button size="sm" disabled={pageIndex === 0} onClick={() => setPage(pageIndex-1)}>上一页</Button>
          <span>{pageIndex+1} / {Math.ceil(filtered.length/100)}</span>
          <Button size="sm" disabled={(pageIndex+1)*100 >= filtered.length} onClick={() => setPage(pageIndex+1)}>下一页</Button>
        </nav> : null}

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
                    height={Math.min(480, displayedItems.length * rowHeight)}
                    width="100%"
                    itemCount={displayedItems.length}
                    itemSize={rowHeight}
                    itemData={{
                      libraryId: summary.libraryId,
                      items: displayedItems,
                      activeTab,
                      onOpenAttention: handleOpenAttention,
                      onOpenPending,
                      onResolvedUnrecognized
                    }}
                  >
                    {AuditRow}
                  </FixedSizeList>
                ) : (
                  displayedItems.map((item) => (
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
