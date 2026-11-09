import { useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Captions, FolderSearch, ListChecks, Search } from 'lucide-react'
import { api } from '../api'
import ScrollViewport from '../components/ScrollViewport'
import EmptyState from '../components/EmptyState'
import { useDesktopSession } from '../desktop/DesktopSessionContext'
import { useBatchScrapeActivity } from '../hooks/useBatchScrapeActivity'
import { pendingCenterPath } from '../listView/pendingRoutes'
import SubtitleTasksDialog from '../playback/SubtitleTasksDialog'
import { playbackTime } from '../playback/playbackTime'
import { useTaskCenterData } from './useTaskCenterData'
import TaskCenterFrame from './TaskCenterFrame'
import { parseTaskTab, taskCenterPath, type TaskTab } from './taskCenterRoutes'
import { subtitleIsRunning, subtitleProgress, type SubtitleTaskFilter } from './taskCenterState'
import { ScrapeTaskList, ScanTaskList } from './TaskPanels'
import styles from './TaskCenter.module.css'

export function TaskProgress({ value, label }: { value: number | null; label: string }): JSX.Element | null {
  return value == null ? null : <progress className={styles.progress} value={value} max={100} aria-label={label} />
}

function OverviewRow({ icon, title, hint, children, state, tab, warning = false, action = '查看' }: {
  icon: ReactNode; title: string; hint: string; children: ReactNode; state: ReactNode; tab: TaskTab; warning?: boolean; action?: string
}): JSX.Element {
  return <section className={styles.row} aria-label={title}>
    {icon}<div className={styles.category}><strong>{title}</strong><small>{hint}</small></div>
    <div className={styles.detail}>{children}</div>
    <div className={`${styles.state} ${warning ? styles.warning : ''}`}>{state}</div>
    <Link draggable={false} className={styles.link} to={taskCenterPath(tab)} aria-label={`${action}${title}`}>{action}<ChevronRight size={14} /></Link>
  </section>
}

export default function TaskCenterPage(): JSX.Element {
  const location = useLocation(), navigate = useNavigate()
  const tab = parseTaskTab(location.search)
  const data = useTaskCenterData()
  const { catalogReadsEnabled } = useDesktopSession()
  const batches = useBatchScrapeActivity()
  const scans = useQuery({ queryKey: ['task-center', 'active-scans'], queryFn: () => api.scan.getActive(),
    refetchInterval: 2000, enabled: catalogReadsEnabled })
  const [refreshing, setRefreshing] = useState(false)
  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try { await Promise.allSettled([data.refresh(), scans.refetch(), ...(batches.refresh ? [batches.refresh()] : [])]) } finally { setRefreshing(false) }
  }
  const tasks = data.local ? data.subtitles.data?.tasks ?? [] : []
  const subtitle = tasks.find(subtitleIsRunning) ?? tasks.find(job => job.status === 'queued')
  const batchList = [batches.videoBatch, batches.actressBatch].filter(batch => batch && batch.status !== 'idle')
  const activeBatch = batchList.find(batch => batch?.status === 'running') ?? batchList.find(batch => batch?.status === 'paused')
  const running = (scans.data?.length ?? 0) + batchList.filter(batch => batch?.status === 'running').length + tasks.filter(subtitleIsRunning).length
  const scan = scans.data?.[0]
  const scanName = data.libraries.data?.find(library => library.id === scan?.libraryId)?.name ?? '媒体库扫描'
  const subtitleError = data.subtitles.isError ? '读取失败' : !data.subtitles.data ? '读取中…' : null
  const pendingText = typeof data.pending === 'number' ? `${data.pending} 项待处理` : data.pending === 'error' ? '读取失败' : '读取中…'
  const rawFilter = new URLSearchParams(location.search).get('status')
  const filter: SubtitleTaskFilter = rawFilter === 'attention' || rawFilter === 'active' || rawFilter === 'finished' ? rawFilter : 'all'
  return <TaskCenterFrame tab={tab} onRefresh={() => void refresh()} refreshing={refreshing}>
    <ScrollViewport key={tab} variant="scroll" className={styles.body}>
      {tab === 'overview' && <>
        <div className={styles.overview}>
          <div className={styles.overviewHead}><span>任务概览</span><span>
            {scans.isError || batches.error || data.local && data.subtitles.isError ? '部分任务状态读取失败' : scans.isPending || batches.loading || data.local && data.subtitles.isPending ? '正在读取任务状态…' : `${running} 项运行中`}
            {' · '}{typeof data.attention === 'number' ? `${data.attention} 项需处理` : data.attention === 'error' ? '待处理数量读取失败' : '正在读取待处理数量…'}
          </span></div>
          <OverviewRow icon={<ListChecks size={20} />} title="待确认" hint="资料与资源归属" tab="pending" action="去处理" warning={typeof data.pending === 'number' && data.pending > 0} state={pendingText}>
            {typeof data.pending === 'number' ? <p>
              <Link draggable={false} className={styles.link} to={pendingCenterPath({ type: 'scan' })}>资源归属 {data.libraries.data?.reduce((sum, library) => sum + library.pendingScanGroupCount, 0)}</Link>
              {' · '}<Link draggable={false} className={styles.link} to={pendingCenterPath({ type: 'scrape' })}>刮削候选 {data.video.data}</Link>
              {' · '}<Link draggable={false} className={styles.link} to={pendingCenterPath({ type: 'actress' })}>演员冲突 {data.actress.data?.groupCount}</Link>
            </p> : <p className={styles.muted}>确认候选资料与资源归属</p>}
          </OverviewRow>
          <OverviewRow icon={<FolderSearch size={20} />} title="扫描" hint="媒体库扫描" tab="scan" state={scans.isError ? '读取失败' : scans.isPending ? '读取中…' : scan ? <><span>已扫描 {scan.progress.scanned}</span><small>扫描中{scans.data!.length > 1 ? ` · 共 ${scans.data!.length} 项` : ''}</small></> : '空闲'}>
            <p>{scan ? scanName : '暂无运行中的扫描'}</p>
            <p className={styles.muted}>{scan ? `已导入 ${scan.progress.imported} 个文件` : '查看各媒体库最近一次扫描结果'}</p>
          </OverviewRow>
          <OverviewRow icon={<Search size={20} />} title="刮削" hint="影片与演员资料" tab="scrape" state={batches.error ? '读取失败' : batches.loading ? '读取中…' : activeBatch ? <><span>{activeBatch.current} / {activeBatch.total}</span><small>{activeBatch.status === 'paused' ? '已暂停' : '进行中'}</small></> : '空闲'}>
            <p>{activeBatch ? activeBatch === batches.videoBatch ? '影片批量刮削' : '演员批量刮削' : '暂无运行中的批量刮削'}</p>
            {activeBatch && <><p className={styles.muted}>{activeBatch.currentCode ? `当前 ${activeBatch.currentCode}` : '等待继续执行'}</p><TaskProgress value={activeBatch.total > 0 ? activeBatch.current / activeBatch.total * 100 : null} label="批量刮削进度" /></>}
          </OverviewRow>
          <OverviewRow icon={<Captions size={20} />} title="字幕" hint="AI 识别与翻译" tab="subtitles" state={!data.local ? '本机功能' : subtitleError ?? (subtitle ? <><span>{subtitleProgress(subtitle) == null ? '准备中' : `${subtitleProgress(subtitle)}%`}</span><small>{subtitle.status === 'saving' ? '保存中' : subtitle.status === 'queued' ? '排队中' : '生成中'}</small></> : data.subtitleAttention ? <span className={styles.warning}>{data.subtitleAttention} 项需处理</span> : '空闲')}>
            <p>{!data.local ? '切换到本机资料库后管理字幕任务' : subtitle?.title ?? '暂无运行中的字幕任务'}</p>
            {subtitle && <><TaskProgress value={subtitleProgress(subtitle)} label="字幕生成进度" /><p className={styles.muted}>识别 {playbackTime(subtitle.recognizedSeconds)}{subtitle.output === 'bilingual' ? ` · 翻译 ${playbackTime(subtitle.translatedSeconds)}` : ''}</p></>}
            {data.local && <p className={styles.muted}>{tasks.filter(job => job.status === 'queued').length} 项排队
              {data.subtitleAttention > 0 && <> · <Link draggable={false} className={`${styles.link} ${styles.warning}`} to={taskCenterPath('subtitles', 'attention')}>{data.subtitleAttention} 项需要处理</Link></>}</p>}
          </OverviewRow>
        </div>
        <p className={styles.notice}>任务可在对应分类中暂停、继续或查看结果。任务关闭应用后的恢复方式以各分类说明为准。</p>
      </>}
      {tab === 'scan' && <ScanTaskList libraries={data.libraries.data ?? []} loading={data.libraries.isPending} error={data.libraries.isError || scans.isError} active={scans.data ?? []} refresh={refresh} />}
      {tab === 'scrape' && <ScrapeTaskList />}
      {tab === 'subtitles' && (data.local ? <SubtitleTasksDialog embedded filter={filter} onFilterChange={value => navigate(taskCenterPath('subtitles', value))} onClose={() => {}} />
        : <EmptyState title="字幕任务在本机资料库中管理">远程影片播放时的实时字幕仍在播放器内使用。</EmptyState>)}
    </ScrollViewport>
  </TaskCenterFrame>
}
