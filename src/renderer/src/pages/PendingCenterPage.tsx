import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, FileVideo, ScanSearch, Trash2 } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { PendingScanGroup, PendingScanResourceTarget } from '@shared/libraryTypes'
import type {
  PendingVideoScrape,
  PendingVideoScrapeConfirmInput,
  PendingVideoScrapeSource,
  VideoScrapeField
} from '@shared/videoScrapeTypes'
import { VIDEO_SCRAPE_FIELD_OPTIONS } from '@shared/videoScrapeTypes'
import { normalizeVideoCode } from '@shared/videoCode'
import { api, resolveMediaSrc } from '../api'
import Button from '../components/Button'
import EmptyState from '../components/EmptyState'
import Modal from '../components/Modal'
import { useToast } from '../components/Toast'
import { UI_ICON_SM } from '../components/iconDefaults'
import { libraryVideoDetailPath } from '../listView/libraryRoutes'
import {
  PENDING_PARAM,
  pendingCenterPath,
  type PendingTab
} from '../listView/pendingRoutes'
import { invalidateVideoLibraryQueries } from '../query/invalidateLibraryQueries'
import {
  arePendingScanAssignmentsComplete,
  arePendingScrapeSelectionsComplete,
  defaultPendingScanPrimaryResourceId,
  pendingScanTargetFromValue,
  pendingScanTargetValue
} from './pendingCenterState'
import styles from './PendingCenterPage.module.css'

const FIELD_LABEL = new Map(
  VIDEO_SCRAPE_FIELD_OPTIONS.map((option) => [option.id, option.label])
)

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}

function formatDuration(value: number | null): string {
  if (value == null) return '时长未知'
  const minutes = Math.floor(value / 60)
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

function fieldSummary(fields: VideoScrapeField[]): string {
  return fields.map((field) => FIELD_LABEL.get(field) ?? field).join('、')
}

function candidateDetailRows(result: PendingVideoScrapeSource['candidates'][number]['result']): Array<[string, string]> {
  const values: Array<[string, unknown]> = [
    ['标题', result.title],
    ['简介', result.summary],
    ['发行日期', result.releaseDate],
    ['发行商', result.publisher],
    ['制作商', result.maker],
    ['系列', result.series],
    ['导演', result.director],
    ['时长', result.durationSeconds == null ? null : `${Math.round(result.durationSeconds / 60)} 分钟`],
    ['演员', result.actresses?.map((actress) => actress.name).join('、')],
    ['标签', result.tags?.join('、')],
    [
      '评分',
      result.ratingAverage == null
        ? null
        : `${result.ratingAverage.toFixed(1)} / 5${result.ratingCount == null ? '' : ` · ${result.ratingCount} 人`}`
    ],
    ['来源', result.sourceUrl]
  ]
  return values.flatMap(([label, value]) =>
    typeof value === 'string' && value.trim() ? [[label, value] as [string, string]] : []
  )
}

function PendingRail({
  tab,
  scanGroups,
  scrapeItems,
  selectedId,
  onSelect
}: {
  tab: PendingTab
  scanGroups: PendingScanGroup[]
  scrapeItems: PendingVideoScrape[]
  selectedId: number | null
  onSelect: (id: number) => void
}): JSX.Element {
  const items = tab === 'scan' ? scanGroups : scrapeItems
  return (
    <aside className={styles.pendingRail} aria-label={tab === 'scan' ? '待确认扫描组' : '待确认影片刮削'}>
      {items.length === 0 ? (
        <EmptyState variant="fill" title="暂无待确认项" />
      ) : (
        items.map((item) => {
          const scan = tab === 'scan' ? (item as PendingScanGroup) : null
          const scrape = tab === 'scrape' ? (item as PendingVideoScrape) : null
          const count = scan?.resources.length ?? scrape?.sources.reduce(
            (sum, source) => sum + source.candidates.length,
            0
          ) ?? 0
          return (
            <button
              type="button"
              key={item.id}
              className={`${styles.pendingRailItem}${selectedId === item.id ? ` ${styles.isActive}` : ''}`}
              onClick={() => onSelect(item.id)}
            >
              <strong className={styles.railTitle}>{scan?.normalizedCode ?? `影片 #${scrape?.videoId}`}</strong>
              <span className={styles.railMeta}>{count} {tab === 'scan' ? '条资源' : '个候选'}</span>
            </button>
          )
        })
      )}
    </aside>
  )
}

function ScanResolutionPane({
  group,
  onResolved
}: {
  group: PendingScanGroup
  onResolved: () => void
}): JSX.Element {
  const toast = useToast()
  const [assignments, setAssignments] = useState<
    Record<number, PendingScanResourceTarget | undefined>
  >({})
  const [primaryByGroup, setPrimaryByGroup] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const existingQuery = useQuery({
    queryKey: ['pending-scan-existing-videos', group.normalizedCode],
    queryFn: async () => {
      const result = await api.videos.list({ search: group.normalizedCode, limit: 200 })
      return result.items.filter((video) => {
        try {
          return normalizeVideoCode(video.code) === group.normalizedCode
        } catch {
          return false
        }
      })
    }
  })
  useEffect(() => {
    setAssignments({})
    setPrimaryByGroup({})
  }, [group.id])
  const complete = arePendingScanAssignmentsComplete(
    group.resources.map((resource) => resource.id),
    assignments
  )
  const newGroupKeys = Array.from({ length: group.resources.length }, (_, index) => String(index + 1))

  const resolve = async (): Promise<void> => {
    if (!complete || busy) return
    setBusy(true)
    try {
      await api.scan.resolvePending(group.id, {
        assignments: group.resources.map((resource) => {
          return {
            resourceId: resource.id,
            target: assignments[resource.id]!
          }
        }),
        primaryResourceIds: primaryByGroup
      })
      toast.show('待确认扫描资源已完成分配', 'success')
      onResolved()
    } catch (error) {
      toast.show((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.pendingDetailPane}>
      <header className={styles.pendingDetailHead}>
        <div>
          <span className={styles.pendingEyebrow}>扫描资源</span>
          <h2 className={styles.detailTitle}>{group.normalizedCode}</h2>
          <p className={styles.detailDescription}>每条资源必须恰好分配一次；此操作不会合并任何现有影片。</p>
        </div>
        <Button variant="primary" disabled={!complete || busy} onClick={() => void resolve()}>
          {busy ? '提交中…' : '确认全部分配'}
        </Button>
      </header>
      <div className={styles.pendingScanResources}>
        {group.resources.map((resource) => {
          const target = assignments[resource.id]
          const newGroupKey = target?.kind === 'new' ? target.groupKey : null
          const defaultPrimaryId = newGroupKey
            ? defaultPendingScanPrimaryResourceId(
                group.resources.filter((candidate) => {
                  const candidateTarget = assignments[candidate.id]
                  return (
                    candidateTarget?.kind === 'new' &&
                    candidateTarget.groupKey === newGroupKey
                  )
                })
              )
            : null
          const effectivePrimaryId = newGroupKey
            ? primaryByGroup[newGroupKey] ?? defaultPrimaryId
            : null
          return (
            <article className={styles.pendingResourceRow} key={resource.id}>
              <FileVideo {...UI_ICON_SM} aria-hidden />
              <div className={styles.pendingResourceCopy}>
                <strong className={`copyable-text ${styles.resourceTitle}`}>{resource.displayName || resource.filePath.split(/[\\/]/).at(-1)}</strong>
                <span className={`copyable-text ${styles.resourcePath}`}>{resource.filePath}</span>
                <small className={styles.resourceFacts}>{formatDuration(resource.durationSeconds)} · {resource.sizeBytes == null ? '大小未知' : formatBytes(resource.sizeBytes)}</small>
              </div>
              <div className={styles.pendingResourceTarget}>
                <select
                  className="select"
                  aria-label={`分配 ${resource.displayName || resource.filePath}`}
                  value={pendingScanTargetValue(target)}
                  onChange={(event) => {
                    const nextTarget = pendingScanTargetFromValue(event.target.value)
                    if (
                      target?.kind === 'new' &&
                      primaryByGroup[target.groupKey] === resource.id
                    ) {
                      setPrimaryByGroup((current) => {
                        const next = { ...current }
                        delete next[target.groupKey]
                        return next
                      })
                    }
                    setAssignments((current) => ({
                      ...current,
                      [resource.id]: nextTarget
                    }))
                  }}
                >
                  <option value="">选择归属…</option>
                  {(existingQuery.data ?? []).map((video) => (
                    <option key={video.id} value={`existing:${video.id}`}>
                      现有影片 #{video.id}{video.title ? ` · ${video.title}` : ''}
                    </option>
                  ))}
                  {newGroupKeys.map((key) => (
                    <option key={key} value={`new:${key}`}>新影片分组 {key}</option>
                  ))}
                </select>
                {newGroupKey ? (
                  <label className={styles.pendingPrimaryChoice}>
                    <input
                      type="radio"
                      name={`primary-${newGroupKey}`}
                      checked={effectivePrimaryId === resource.id}
                      onChange={() =>
                        setPrimaryByGroup((current) => ({ ...current, [newGroupKey]: resource.id }))
                      }
                    />
                    设为该新影片的主资源
                  </label>
                ) : null}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function ScrapeResolutionPane({
  pending,
  onResolved
}: {
  pending: PendingVideoScrape
  onResolved: () => void
}): JSX.Element {
  const toast = useToast()
  const navigate = useNavigate()
  const [selections, setSelections] = useState<Record<number, number>>({})
  const [busy, setBusy] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [mergeConflictId, setMergeConflictId] = useState<number | null>(null)
  const [directorChoice, setDirectorChoice] = useState<{
    candidates: Array<{ id: number; mainName: string; description: string | null }>
  } | null>(null)
  const [directorId, setDirectorId] = useState<number | null>(null)

  useEffect(() => {
    setSelections({})
    setMergeConflictId(null)
    setDirectorChoice(null)
    setDirectorId(null)
  }, [pending.id, pending.revision])

  const confirmInput = (): PendingVideoScrapeConfirmInput => ({
    pendingScrapeId: pending.id,
    selections: pending.sources.map((source) => ({
      sourceId: source.id,
      candidateId: selections[source.id]
    }))
  })
  const complete = arePendingScrapeSelectionsComplete(pending.sources, selections)
  const candidateCount = pending.sources.reduce((sum, source) => sum + source.candidates.length, 0)

  const confirm = async (extra: Partial<PendingVideoScrapeConfirmInput> = {}): Promise<void> => {
    if (!complete || busy) return
    setBusy(true)
    try {
      const result = await api.scrape.confirmPending({ ...confirmInput(), ...extra })
      if (result.status === 'merge-required' && result.conflictVideoId) {
        setMergeConflictId(result.conflictVideoId)
        return
      }
      if (result.directorChoice) {
        setDirectorChoice(result.directorChoice)
        return
      }
      toast.show(result.applied ? '候选已应用' : '没有可写入字段，已跳过', result.applied ? 'success' : 'info')
      onResolved()
    } catch (error) {
      toast.show((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const discard = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.scrape.discardPending(pending.id)
      toast.show('候选已丢弃并清理暂存资源', 'success')
      setDiscardOpen(false)
      onResolved()
    } catch (error) {
      toast.show((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.pendingDetailPane}>
      <header className={styles.pendingDetailHead}>
        <div>
          <span className={styles.pendingEyebrow}>影片刮削</span>
          <h2 className={styles.detailTitle}>影片 #{pending.videoId}</h2>
          <p className={styles.detailDescription}>选择会按原字段和更新模式应用；关闭页面不会丢弃候选。</p>
        </div>
        <div className={styles.pendingDetailActions}>
          <Button variant="ghost" onClick={() => navigate(libraryVideoDetailPath(pending.videoId))}>查看影片</Button>
          <Button variant="danger" onClick={() => setDiscardOpen(true)}><Trash2 {...UI_ICON_SM} aria-hidden />丢弃</Button>
          <Button variant="primary" disabled={!complete || busy} onClick={() => void confirm()}>
            {busy ? '处理中…' : '应用所选候选'}
          </Button>
        </div>
      </header>
      <div className={styles.pendingSnapshotMeta}>
        <span>原选字段：{fieldSummary(pending.selectedFields) || '无'}</span>
        <span>更新方式：{pending.updateMode}</span>
        <span>暂存占用：{formatBytes(pending.stagedBytes)}</span>
      </div>
      {pending.warnings.length > 0 ? (
        <div className={styles.pendingWarningList} role="status">
          {pending.warnings.map((warning, index) => <span key={`${warning}-${index}`}>{warning}</span>)}
        </div>
      ) : null}
      <div className={styles.pendingSourceList}>
        {pending.sources.map((source) => (
          <section className={styles.pendingSourceSection} key={source.id}>
            <header className={styles.sourceHeader}>
              <div className={styles.sourceIdentity}><strong>{source.pluginName}</strong><span className={styles.sourceVersion}>{source.pluginVersion || '版本未知'} · {source.sourceName}</span></div>
              <small className={styles.sourceFields}>{fieldSummary(source.selectedFields)}</small>
            </header>
            <div className={styles.pendingCandidateGrid}>
              {source.candidates.map((candidate) => {
                const cover = resolveMediaSrc(candidate.stagedCoverPath)
                const samples = candidate.stagedSamplePaths
                  .map(resolveMediaSrc)
                  .filter((value): value is string => Boolean(value))
                const avatars = candidate.stagedActressAvatarPaths
                  .map(resolveMediaSrc)
                  .filter((value): value is string => Boolean(value))
                const selected = selections[source.id] === candidate.id
                return (
                  <label className={`${styles.pendingCandidateCard}${selected ? ` ${styles.isSelected}` : ''}`} key={candidate.id}>
                    <input
                      className={styles.candidateInput}
                      type="radio"
                      name={`source-${source.id}`}
                      checked={selected}
                      onChange={() => setSelections((current) => ({ ...current, [source.id]: candidate.id }))}
                    />
                    <div className={styles.pendingCandidateCover}>
                      {cover ? <img className={styles.candidateImage} src={cover} alt="" draggable={false} /> : <CircleAlert aria-hidden />}
                    </div>
                    <div className={styles.pendingCandidateCopy}>
                      <strong className={styles.candidateTitle}>{candidate.result.title || candidate.result.code}</strong>
                      {candidateDetailRows(candidate.result).map(([label, value]) => (
                        <div className={styles.candidateRow} key={label}><span className={styles.candidateLabel}>{label}</span><b className={`copyable-text ${styles.candidateValue}`}>{value}</b></div>
                      ))}
                    </div>
                    {samples.length > 0 || avatars.length > 0 ? (
                      <div className={styles.candidateMedia} aria-label="候选暂存图片">
                        {samples.map((sample, index) => (
                          <img
                            className={styles.candidateThumbnail}
                            src={sample}
                            alt={`候选样张 ${index + 1}`}
                            draggable={false}
                            key={`sample-${index}`}
                          />
                        ))}
                        {avatars.map((avatar, index) => (
                          <img
                            className={styles.candidateThumbnail}
                            data-avatar="true"
                            src={avatar}
                            alt={`候选演员头像 ${index + 1}`}
                            draggable={false}
                            key={`avatar-${index}`}
                          />
                        ))}
                      </div>
                    ) : null}
                  </label>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      {discardOpen ? (
        <Modal
          title="丢弃影片刮削候选？"
          hint={`将删除 ${candidateCount} 个候选及 ${formatBytes(pending.stagedBytes)} 暂存资源。关闭窗口本身不会执行此操作。`}
          danger
          busy={busy}
          confirmText="确认丢弃"
          onCancel={() => setDiscardOpen(false)}
          onConfirm={() => void discard()}
        ><p className="copyable-text">影片 #{pending.videoId} 的本次刮削会记为失败；已有累计成功状态不会降级。</p></Modal>
      ) : null}

      {mergeConflictId != null ? (
        <Modal
          title="合并并应用候选"
          hint={`所选候选与影片 #${mergeConflictId} 的业务身份相同。请选择要保留的永久内部 ID。`}
          size="sm"
          hideCancel
          onCancel={() => setMergeConflictId(null)}
          actions={
            <>
              <Button onClick={() => setMergeConflictId(null)}>取消</Button>
              <Button variant="primary" onClick={() => void confirm({ mergeRetainedVideoId: mergeConflictId })}>保留 #{mergeConflictId}</Button>
              <Button variant="primary" onClick={() => void confirm({ mergeRetainedVideoId: pending.videoId })}>保留 #{pending.videoId}</Button>
            </>
          }
        ><p>两部影片的资源和关系将原子收敛，随后应用当前候选；任一步失败都不会部分提交。</p></Modal>
      ) : null}

      {directorChoice ? (
        <Modal
          title="选择导演"
          hint="导演名称匹配到多个分类实体；完成选择前不会写入其他候选字段。"
          confirmDisabled={directorId == null}
          confirmText="选择并应用"
          onCancel={() => { setDirectorChoice(null); setDirectorId(null) }}
          onConfirm={() => directorId != null && void confirm({ directorSelectionId: directorId })}
        >
          <div className={styles.pendingDirectorOptions}>
            {directorChoice.candidates.map((candidate) => (
              <label className={styles.directorOption} key={candidate.id}>
                <input type="radio" name="pending-director" checked={directorId === candidate.id} onChange={() => setDirectorId(candidate.id)} />
                <span className={styles.directorCopy}><strong>{candidate.mainName}</strong>{candidate.description ? <small className={styles.directorDescription}>{candidate.description}</small> : null}</span>
              </label>
            ))}
          </div>
        </Modal>
      ) : null}
    </section>
  )
}

export default function PendingCenterPage(): JSX.Element {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const tab: PendingTab = params.get(PENDING_PARAM.tab) === 'scrape' ? 'scrape' : 'scan'
  const selectedFromUrl = Number(params.get(PENDING_PARAM.id))
  const videoFromUrl = Number(params.get(PENDING_PARAM.videoId))
  const scanQuery = useQuery({ queryKey: ['pending-scan-groups'], queryFn: () => api.scan.listPending() })
  const scrapeQuery = useQuery({ queryKey: ['pending-video-scrapes'], queryFn: () => api.scrape.listPending() })
  const items = tab === 'scan' ? scanQuery.data ?? [] : scrapeQuery.data ?? []
  const scrapeByVideo = tab === 'scrape' && Number.isInteger(videoFromUrl)
    ? (scrapeQuery.data ?? []).find((item) => item.videoId === videoFromUrl)?.id
    : undefined
  const selectedId = scrapeByVideo ?? (
    Number.isInteger(selectedFromUrl) && items.some((item) => item.id === selectedFromUrl)
      ? selectedFromUrl
      : items[0]?.id ?? null
  )
  const selectedScan = tab === 'scan'
    ? (scanQuery.data ?? []).find((item) => item.id === selectedId) ?? null
    : null
  const selectedScrape = tab === 'scrape'
    ? (scrapeQuery.data ?? []).find((item) => item.id === selectedId) ?? null
    : null
  const scanCount = scanQuery.data?.length ?? 0
  const scrapeCount = scrapeQuery.data?.length ?? 0
  const loading = scanQuery.isLoading || scrapeQuery.isLoading

  const navigateTab = (next: PendingTab): void => navigate(pendingCenterPath({ tab: next }))
  const selectItem = (id: number): void => navigate(pendingCenterPath({ tab, id }))
  const refresh = (): void => {
    invalidateVideoLibraryQueries(queryClient)
    void scanQuery.refetch()
    void scrapeQuery.refetch()
  }

  return (
    <div className={`list-page ${styles.pendingCenterPage}`}>
      <header className={`topbar ${styles.pendingCenterTopbar}`}>
        <div>
          <h1 className={styles.pageTitle}>待确认</h1>
          <p className={styles.pageSubtitle}>处理扫描资源归属和影片刮削候选。</p>
        </div>
        <div className={styles.pendingTabs} role="tablist" aria-label="待确认类型">
          <button type="button" role="tab" aria-selected={tab === 'scan'} className={`${styles.tab}${tab === 'scan' ? ` ${styles.isActive}` : ''}`} onClick={() => navigateTab('scan')}>
            <ScanSearch {...UI_ICON_SM} aria-hidden />扫描资源 <span className={styles.tabCount}>{scanCount}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'scrape'} className={`${styles.tab}${tab === 'scrape' ? ` ${styles.isActive}` : ''}`} onClick={() => navigateTab('scrape')}>
            <CircleAlert {...UI_ICON_SM} aria-hidden />影片刮削 <span className={styles.tabCount}>{scrapeCount}</span>
          </button>
        </div>
      </header>
      <div className="scroll-body scroll-body--fill">
        <div className={styles.pendingWorkspace}>
        <PendingRail
          tab={tab}
          scanGroups={scanQuery.data ?? []}
          scrapeItems={scrapeQuery.data ?? []}
          selectedId={selectedId}
          onSelect={selectItem}
        />
        <main className={`scroll-body scroll-body--scroll ${styles.pendingWorkspaceMain}`}>
          {loading ? (
            <EmptyState variant="fill" loading title="正在读取待确认项…" />
          ) : selectedScan ? (
            <ScanResolutionPane group={selectedScan} onResolved={refresh} />
          ) : selectedScrape ? (
            <ScrapeResolutionPane pending={selectedScrape} onResolved={refresh} />
          ) : (
            <EmptyState variant="fill" title="暂无待确认项" description="新的扫描歧义或刮削候选会显示在这里。" />
          )}
        </main>
        </div>
      </div>
    </div>
  )
}
