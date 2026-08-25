import { useMemo, useState } from 'react'
import { FixedSizeList, type ListChildComponentProps } from 'react-window'
import type {
  LibraryScanAudit,
  LibraryScanFileAuditEntry,
  LibraryScanMetricKey,
  LibraryScanResourceAuditEntry,
  LibraryScanSummary
} from '@shared/libraryTypes'
import { FolderOpen } from 'lucide-react'
import Button from '../Button'
import { UI_ICON_SM } from '../iconDefaults'
import { SettingsEmptyPanel, SettingsStatusPill } from './SettingsPrimitives'
import UnrecognizedRow from './UnrecognizedRow'
import { api } from '../../api'
import { useToast } from '../Toast'
import styles from './LibraryScanAuditPanel.module.css'

const METRICS: Array<{ key: LibraryScanMetricKey; label: string; definition: string }> = [
  { key: 'resourcesAdded', label: '新增资源', definition: '本次扫描中新建或挂载到已有影片的资源。' },
  { key: 'resourcesUpdated', label: '更新资源', definition: '路径重定位、文件信息刷新或 STRM 目标同步。' },
  { key: 'resourcesRemoved', label: '移除资源', definition: '确认源文件缺失或路径已移除后清理的资源记录。' },
  { key: 'primaryResourcesPromoted', label: '提升主资源', definition: '原主资源被移除后自动选出的新主资源。' },
  { key: 'videosDeleted', label: '删除影片', definition: '启用扫描后清理时删除的无资源影片。' },
  { key: 'scannedFiles', label: '扫描文件', definition: '已处理文件的主清单；每个文件只有一个最终结果。' },
  { key: 'skippedFiles', label: '跳过文件', definition: '未变化、时长不足或重复的文件。' },
  { key: 'failedFiles', label: '异常文件', definition: '无法识别、STRM 解析失败或处理失败的文件。' },
  { key: 'pendingScanGroups', label: '待确认组', definition: '本次扫描涉及的资源归属确认组。' },
  { key: 'pendingScanResources', label: '待确认资源', definition: '本次扫描新加入待确认队列的资源。' }
]

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
  path?: string
  videoId?: number
  groupId?: number
  status?: string
}

function metricValue(summary: LibraryScanSummary, key: LibraryScanMetricKey): number {
  return summary[key]
}

function fileDetail(entry: LibraryScanFileAuditEntry): string {
  switch (entry.outcome) {
    case 'added': return entry.createdVideo ? '新建影片并添加资源' : '挂载到已有影片'
    case 'updated': return { relocated: '路径已重定位', metadata_refreshed: '文件信息已刷新', strm_target_synced: 'STRM 目标已同步' }[entry.updateKind]
    case 'pending': return `${entry.normalizedCode || '番号未知'} · ${entry.sourceKind === 'strm' ? 'STRM' : '本地文件'} · ${entry.addedToQueue ? '已加入待确认队列' : '仍在待确认队列'}`
    case 'skipped': return { unchanged: '未变化', below_min_duration: '低于最短时长', duplicate: '重复资源' }[entry.skipReason]
    case 'unrecognized': return '文件名未识别出番号'
    case 'strm_failure': return entry.message
    case 'processing_failure': return entry.message
  }
}

function fileView(entry: LibraryScanFileAuditEntry, index: number): ViewItem {
  return {
    key: `file:${index}:${entry.filePath}`,
    title: `${OUTCOME_LABEL[entry.outcome]} · ${entry.filePath.split(/[\\/]/).pop() || entry.filePath}`,
    detail: fileDetail(entry),
    path: entry.filePath,
    videoId: 'videoId' in entry ? entry.videoId : undefined,
    groupId: entry.outcome === 'pending' ? entry.groupId ?? undefined : undefined
  }
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
    detail: `${entry.resourceKind.toUpperCase()} · ${reason} · ${entry.displayName || entry.sourcePath || '外部目标已隐藏'}`,
    path: entry.sourcePath ?? undefined,
    videoId: entry.videoId
  }
}

function AuditRow({ index, style, data }: ListChildComponentProps<ViewItem[]>): JSX.Element {
  return <AuditRowContent item={data[index]} style={style} />
}

function AuditRowContent({ item, style }: { item: ViewItem; style?: React.CSSProperties }): JSX.Element {
  const toast = useToast()
  const copyPath = async (): Promise<void> => {
    if (!item.path) return
    await navigator.clipboard.writeText(item.path)
    toast.show('路径已复制', 'success')
  }
  const reveal = async (): Promise<void> => {
    if (!item.path) return
    const result = await api.scan.revealAuditFile(item.path)
    if (!result.ok) toast.show(result.fileMissing ? '文件已不存在' : result.error || '无法打开目录', 'error')
  }
  return (
    <div className={styles.rowSlot} style={style}>
      <div className={styles.row}>
        <div className={styles.rowCopy}>
          <strong>{item.title}</strong>
          <span>{item.detail}</span>
          {item.status ? <small>{item.status}</small> : null}
        </div>
        <div className={styles.rowActions}>
          {item.videoId ? <Button type="button" size="sm" data-video-id={item.videoId}>查看影片</Button> : null}
          {item.groupId ? <Button type="button" size="sm" data-group-id={item.groupId}>处理归属</Button> : null}
          {item.path ? <Button type="button" size="sm" onClick={() => void copyPath()}>复制路径</Button> : null}
          {item.path ? <Button type="button" size="sm" onClick={() => void reveal()}><FolderOpen {...UI_ICON_SM} aria-hidden />在文件夹中显示</Button> : null}
        </div>
      </div>
    </div>
  )
}

export default function LibraryScanAuditPanel({
  summary,
  audit,
  selected,
  unrecognized,
  unrecognizedScanFinishedAt,
  currentPendingGroupIds,
  onSelect,
  onResolvedUnrecognized,
  onOpenVideo,
  onOpenPending
}: {
  summary: LibraryScanSummary
  audit: LibraryScanAudit | null
  selected: LibraryScanMetricKey | null
  unrecognized: string[]
  unrecognizedScanFinishedAt: string | null
  currentPendingGroupIds: Set<number>
  onSelect: (key: LibraryScanMetricKey | null) => void
  onResolvedUnrecognized: (path: string) => void
  onOpenVideo: (videoId: number) => void
  onOpenPending: (groupId?: number) => void
}): JSX.Element {
  const [search, setSearch] = useState('')
  const [outcome, setOutcome] = useState<LibraryScanFileAuditEntry['outcome'] | 'all'>('all')
  const matchedAudit = audit?.finishedAt === summary.finishedAt ? audit : null
  const currentSnapshot = unrecognizedScanFinishedAt === summary.finishedAt
  const definition = METRICS.find((metric) => metric.key === selected)?.definition ?? ''

  const items = useMemo((): ViewItem[] => {
    if (!selected || !matchedAudit) return []
    if (selected === 'resourcesRemoved') {
      const deletedVideoIds = new Set(matchedAudit.deletedVideos.map((entry) => entry.videoId))
      return matchedAudit.removedResources.map((entry, index) => {
        const item = resourceView(entry, index)
        if (deletedVideoIds.has(entry.videoId)) item.videoId = undefined
        return item
      })
    }
    if (selected === 'primaryResourcesPromoted') return matchedAudit.promotedResources.map(resourceView)
    if (selected === 'videosDeleted') return matchedAudit.deletedVideos.map((entry, index) => ({
      key: `deleted:${index}:${entry.videoId}`,
      title: `${entry.videoCode}${entry.videoTitle ? ` · ${entry.videoTitle}` : ''}`,
      detail: '扫描后清理的无资源影片'
    }))
    if (selected === 'pendingScanGroups') return matchedAudit.pendingGroups.map((entry) => ({
      key: `pending-group:${entry.groupId}`,
      title: entry.normalizedCode,
      detail: `${entry.resourceCount} 个扫描资源`,
      groupId: currentPendingGroupIds.has(entry.groupId) ? entry.groupId : undefined,
      status: currentPendingGroupIds.has(entry.groupId) ? '待处理' : '已处理'
    }))
    let files = matchedAudit.files
    if (selected === 'resourcesAdded') files = files.filter((entry) => entry.outcome === 'added')
    else if (selected === 'resourcesUpdated') files = files.filter((entry) => entry.outcome === 'updated')
    else if (selected === 'skippedFiles') files = files.filter((entry) => entry.outcome === 'skipped')
    else if (selected === 'failedFiles') files = files.filter((entry) => ['unrecognized', 'strm_failure', 'processing_failure'].includes(entry.outcome))
    else if (selected === 'pendingScanResources') files = files.filter((entry) => entry.outcome === 'pending' && entry.addedToQueue)
    if (selected === 'scannedFiles' && outcome !== 'all') files = files.filter((entry) => entry.outcome === outcome)
    return files.map((entry, index) => {
      const item = fileView(entry, index)
      if (entry.outcome === 'pending') {
        const pending = entry.groupId != null && currentPendingGroupIds.has(entry.groupId)
        item.status = pending ? '待处理' : '已处理'
        if (!pending) item.groupId = undefined
      } else if (entry.outcome === 'unrecognized') {
        const pending = currentSnapshot && unrecognized.includes(entry.filePath)
        item.status = pending ? '待处理' : '已处理'
      }
      return item
    })
  }, [currentPendingGroupIds, currentSnapshot, matchedAudit, outcome, selected, unrecognized])

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return query ? items.filter((item) => `${item.title} ${item.detail} ${item.path ?? ''}`.toLocaleLowerCase().includes(query)) : items
  }, [items, search])

  return (
    <div className={styles.root}>
      <div className={styles.metrics}>
        {METRICS.map((metric) => (
          <button
            type="button"
            key={metric.key}
            className={selected === metric.key ? styles.metricSelected : styles.metric}
            aria-pressed={selected === metric.key}
            onClick={() => onSelect(selected === metric.key ? null : metric.key)}
          >
            <strong>{metricValue(summary, metric.key)}</strong>
            <span>{metric.label}</span>
          </button>
        ))}
      </div>
      {selected ? (
        <section className={styles.detail} aria-label="扫描审计明细">
          <div className={styles.detailHead}>
            <div><strong>{METRICS.find((metric) => metric.key === selected)?.label}</strong><span>{definition}</span></div>
            <SettingsStatusPill status="muted">{filtered.length} 项</SettingsStatusPill>
          </div>
          {matchedAudit ? (
            <>
              <div className={styles.toolbar}>
                <input className="text-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索番号、文件名或路径" aria-label="搜索扫描明细" />
                {selected === 'scannedFiles' ? (
                  <select className="app-select" value={outcome} onChange={(event) => setOutcome(event.target.value as typeof outcome)} aria-label="筛选扫描结果">
                    <option value="all">全部结果</option>
                    {Object.entries(OUTCOME_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                ) : null}
              </div>
              {filtered.length > 0 ? (
                <div
                  className={styles.list}
                  onClick={(event) => {
                    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-video-id], [data-group-id]')
                    if (!target) return
                    const videoId = Number(target.dataset.videoId)
                    const groupId = Number(target.dataset.groupId)
                    if (Number.isInteger(videoId) && videoId > 0) onOpenVideo(videoId)
                    else if (Number.isInteger(groupId) && groupId > 0) onOpenPending(groupId)
                  }}
                >
                  {filtered.length > 8 ? (
                    <FixedSizeList height={Math.min(492, filtered.length * 82)} width="100%" itemCount={filtered.length} itemSize={82} itemData={filtered}>{AuditRow}</FixedSizeList>
                  ) : filtered.map((item) => <AuditRowContent key={item.key} item={item} />)}
                </div>
              ) : <SettingsEmptyPanel variant="compact">没有符合条件的明细</SettingsEmptyPanel>}
            </>
          ) : <SettingsEmptyPanel variant="compact">此扫描仅保留了摘要，下一次扫描后会生成完整明细。</SettingsEmptyPanel>}
          {selected === 'failedFiles' && unrecognized.length > 0 ? (
            <div className={styles.unrecognized}>
              <div className={styles.unrecognizedHead}>
                <strong>{currentSnapshot ? '本次扫描的待处理文件' : '上一次安全扫描留下的待处理文件'}</strong>
                <SettingsStatusPill status="warning">{unrecognized.length} 个待处理</SettingsStatusPill>
              </div>
              {unrecognized.map((filePath) => <UnrecognizedRow key={filePath} path={filePath} onResolved={onResolvedUnrecognized} />)}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
