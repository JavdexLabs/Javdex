import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { MediaLibrarySummary } from '@shared/mediaLibraryTypes'
import type { LibraryScanProgressEvent } from '@shared/libraryTypes'
import { api } from '../api'
import Button from '../components/Button'
import EmptyState from '../components/EmptyState'
import { useBatchScrapeActivity } from '../hooks/useBatchScrapeActivity'
import { mediaLibrarySettingsPath } from '../listView/mediaLibraryRoutes'
import { pendingCenterPath } from '../listView/pendingRoutes'
import { settingsPath } from '../settings/settingsRoutes'
import { batchStatusLabel } from '../settings/settingsDisplay'
import { useDesktopSession } from '../desktop/DesktopSessionContext'
import styles from './TaskCenter.module.css'

export function ScrapeTaskList(): JSX.Element {
  const batches = useBatchScrapeActivity()
  const { capabilities } = useDesktopSession()
  const canControl = capabilities.runPlugins.allowed
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const items = [{ kind: 'video', title: '影片批量刮削', batch: batches.videoBatch }, { kind: 'actress', title: '演员批量刮削', batch: batches.actressBatch }].filter(item => item.batch && item.batch.status !== 'idle')
  async function command(action: 'pause' | 'resume' | 'discard'): Promise<void> {
    if (busy) return
    setBusy(true); setError(null)
    try { await api.batchScrape[action](); setConfirm(false) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  return <div>
    <div className={styles.filterBar}><p className={styles.notice}>批量任务离开页面后继续执行；退出应用后保留断点。最近结果不作为永久历史保存。</p><Link draggable={false} className={styles.link} to={settingsPath('overview', 'status')}>发起批量刮削</Link></div>
    {(error || batches.error) && <p className={styles.error} role="alert">{error || batches.error}</p>}
    {!items.length && <EmptyState title={batches.loading ? '正在读取刮削任务…' : batches.error ? '刮削任务读取失败' : '暂无批量刮削任务'} />}
    {items.map(({ kind, title, batch }) => batch && <section className={styles.task} aria-label={title} key={kind}>
      <div className={styles.taskHead}><h2>{title}</h2><span className={styles.muted}>{batchStatusLabel(batch.status)}</span></div>
      <p>{batch.current} / {batch.total} · 成功 {batch.success} · 待确认 {batch.pending} · 失败 {batch.failed}</p>
      {batch.total > 0 && <progress className={styles.progress} value={batch.current} max={batch.total} aria-label={`${title}进度`} />}
      {batch.currentCode && <p className={styles.muted}>当前 {batch.currentCode}</p>}
      <div className={styles.actions}>
        {batch.status === 'running' && <Button size="sm" disabled={busy || !canControl} onClick={() => void command('pause')}>暂停</Button>}
        {batch.status === 'paused' && <Button size="sm" disabled={busy || !canControl || kind === 'actress' && !batches.actressBatchRecoverable} onClick={() => void command('resume')}>继续</Button>}
        {['running', 'paused'].includes(batch.status) && <Button size="sm" disabled={busy || !canControl} onClick={() => setConfirm(true)}>终止任务</Button>}
        <Link draggable={false} className={styles.link} to={pendingCenterPath({ type: kind === 'video' ? 'scrape' : 'actress' })}>查看待确认</Link>
      </div>
      {kind === 'actress' && !batches.actressBatchRecoverable && <p className={styles.error}>{batches.actressBatchUnrecoverableReason}</p>}
      <details className={styles.logs}><summary>运行记录（{batch.logs.length}）</summary><div className={styles.logList}>{batch.logs.map((log, index) => <p key={index} className={log.level === 'error' ? styles.error : styles.muted}>{log.time} · {log.code} · {log.message}</p>)}</div></details>
    </section>)}
    {confirm && <section className={styles.task} aria-label="确认终止刮削"><p>终止当前批量任务？已经写入的资料保留，未完成部分不再继续。</p><div className={styles.actions}><Button size="sm" variant="danger" disabled={busy} onClick={() => void command('discard')}>确认终止</Button><Button size="sm" disabled={busy} onClick={() => setConfirm(false)}>返回</Button></div></section>}
  </div>
}

export function ScanTaskList({ libraries, loading, error, active, refresh }: {
  libraries: MediaLibrarySummary[]; loading: boolean; error: boolean; active: LibraryScanProgressEvent[]; refresh(): Promise<void>
}): JSX.Element {
  return <div>
    <p className={styles.notice}>按媒体库查看正在执行和最近一次扫描。扫描期间显示已处理文件数，取消后保留已提交的结果。</p>
    {error && <p className={styles.error} role="alert">扫描状态读取失败，请刷新后重试。</p>}
    {!libraries.length && <EmptyState title={loading ? '正在读取媒体库…' : error ? '无法读取媒体库' : '暂无媒体库'} />}
    {libraries.map(library => <ScanTask key={library.id} library={library} active={active.find(run => run.libraryId === library.id)} refresh={refresh} statusUnavailable={error || loading} />)}
  </div>
}

function ScanTask({ library, active, refresh, statusUnavailable }: { library: MediaLibrarySummary; active?: LibraryScanProgressEvent; refresh(): Promise<void>; statusUnavailable: boolean }): JSX.Element {
  const { capabilities, catalogReadsEnabled } = useDesktopSession()
  const latest = useQuery({ queryKey: ['task-center', 'scan-result', library.id], queryFn: () => api.scan.getAuditHeader(library.id), refetchInterval: active ? 2000 : 5000, enabled: catalogReadsEnabled })
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const summary = latest.data?.summary
  async function cancel(): Promise<void> {
    if (!active || busy) return
    setBusy(true); setError(null)
    try {
      if (!await api.scan.cancel(active.runId)) setError('该扫描已结束，请刷新状态。')
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const status = active ? '扫描中' : statusUnavailable ? '状态未知' : latest.isPending ? '读取中…' : latest.isError ? '读取失败' : !summary ? '尚未扫描' : ({ success: '已完成', completed_with_errors: '完成，部分失败', failed: '扫描失败', cancelled: '已取消' } as const)[summary.status]
  return <section className={styles.task} aria-label={`${library.name}扫描`}>
    <div className={styles.taskHead}><h2>{library.name}</h2><span className={styles.muted}>{status}</span></div>
    {active ? <><p>已扫描 {active.progress.scanned} 个文件 · 已导入 {active.progress.imported}</p>{active.progress.currentFile && <p className={styles.muted}>{active.progress.currentFile}</p>}</>
      : summary && <><p>扫描 {summary.scannedFiles} · 新增 {summary.resourcesAdded} · 更新 {summary.resourcesUpdated} · 失败 {summary.failedFiles}</p><p className={styles.muted}>{new Date(summary.finishedAt).toLocaleString()}</p>{summary.errorSummary && <p className={styles.error}>{summary.errorSummary}</p>}</>}
    {(error || latest.isError) && <p className={styles.error} role="alert">{error ?? '扫描结果读取失败，请重试。'}</p>}
    <div className={styles.actions}>
      {active && <Button size="sm" disabled={busy || !capabilities.editCatalog.allowed} onClick={() => void cancel()}>取消扫描</Button>}
      <Link draggable={false} className={styles.link} to={mediaLibrarySettingsPath(library.id, 'sources')}>扫描设置与详细结果</Link>
      {library.pendingScanGroupCount > 0 && <Link draggable={false} className={styles.link} to={pendingCenterPath({ type: 'scan', libraryId: library.id })}>处理资源归属（{library.pendingScanGroupCount}）</Link>}
    </div>
  </section>
}
