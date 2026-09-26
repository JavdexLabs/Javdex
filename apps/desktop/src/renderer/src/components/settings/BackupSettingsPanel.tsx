import SettingsFeedback from './SettingsFeedback'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, Archive, Check, ChevronDown, ChevronRight, Download, FolderOpen, Trash2, Upload } from 'lucide-react'
import type { BackupJob, BackupMapping, BackupRemovalPreview, BackupRequest, DesktopBackupFileRequest } from '@shared/protocol/backup'
import { api } from '../../api'
import { useDesktopSession } from '../../desktop/DesktopSessionContext'
import RemoteRootPicker from '../../pages/RemoteRootPicker'
import Button from '../Button'
import Modal from '../Modal'
import Checkbox from '../../../../../../../packages/ui/src/Checkbox'
import Spinner from '../Spinner'
import { UI_ICON_SM } from '../iconDefaults'
import { SettingsCard } from './SettingsPrimitives'
import styles from './BackupSettingsPanel.module.css'

const phaseLabels: Record<BackupJob['phase'], string> = {
  receiving: '上传备份', snapshot: '创建快照', packing: '打包备份', inspecting: '校验备份',
  ready: '准备恢复', protecting: '备份目标资料库', applying: '恢复资料', completed: '已完成',
  cancelled: '已取消', failed: '操作失败', recoveryRequired: '需要恢复处理',
  awaitingImages: '核对缺失图片'
}
const runningPhases = new Set(['receiving', 'snapshot', 'awaitingImages', 'packing', 'inspecting', 'protecting', 'applying'])
const finishedPhases = new Set(['completed', 'failed', 'cancelled'])
const progressLabels = { checking: '检查图片文件', database: '复制资料库', copying: '复制图片', decrypting: '处理图片加密', paths: '整理图片引用', checksums: '计算文件校验值', packing: '压缩备份文件' }
const phaseHints: Partial<Record<BackupJob['phase'], string>> = {
  snapshot: '正在准备资料库和图片副本，图片较多时需要一些时间。',
  packing: '正在压缩并校验备份文件，请保持应用开启。',
  inspecting: '正在检查备份格式、数据库与图片完整性；旧版本资料会在临时副本中升级。',
  protecting: '正在创建目标资料库的自动备份，完成后才会覆盖恢复。',
  applying: '正在提交恢复，请保持应用开启。此阶段不能取消。',
  receiving: '正在将备份上传到目标资料库。'
}
function JobProgress({ job, now }: { job: BackupJob; now: number }): JSX.Element {
  const progress = ['snapshot', 'packing'].includes(job.phase) ? job.progress : undefined
  const elapsed = Math.max(0, Math.floor((now - Date.parse(job.createdAt)) / 1000))
  const quiet = progress && now - Date.parse(progress.updatedAt) > 30000
  return <div className={styles.progress} role="status" aria-live="polite">
    <div className={styles.actions}><Spinner size="sm" aria-hidden="true" /><strong>{progress ? progressLabels[progress.stage] : phaseLabels[job.phase]}…</strong></div>
    <p className={styles.hint}>{phaseHints[job.phase]}</p>
    {progress && progress.total > 0 && <progress className={styles.progressBar} aria-label={progressLabels[progress.stage]} value={progress.completed} max={progress.total} />}
    <div className={styles.progressMeta}>{progress && progress.total > 0 && <span>{progress.completed} / {progress.total} {progress.stage === 'database' ? '数据库页' : '个文件'}（当前阶段）</span>}<span className={styles.hint}>已用时 {Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒</span></div>
    {quiet && <p>超过 30 秒未收到新的处理进度，暂不能确定是否停滞。可以继续等待或取消后重试。</p>}
  </div>
}
function MissingImages({ paths }: { paths: string[] }): JSX.Element {
  return <div><p>缺少 {paths.length} 张图片。补齐后可取消本次操作并重新备份；也可确认继续，保留其余资料和图片。</p>
    <details><summary>查看缺失图片路径（{paths.length}）</summary><div className={styles.missingPaths}>{paths.map(rel => <div className={styles.path} key={rel}>{rel}</div>)}</div></details>
  </div>
}
function describeMapping(mapping?: BackupMapping): string {
  const target = mapping?.target
  if (!target) return '尚未选择目标目录'
  if (target.kind === 'omit') return '仅保留资料，移除本地资源关联'
  return target.kind === 'local' ? target.path : `${target.mountSelectionId}/${target.relativePath}`
}
function size(bytes: number): string { return `${(bytes / 1024 / 1024).toFixed(1)} MiB` }

function Feedback({ message = '', pending = false, hint = '' }: { message?: string; pending?: boolean; hint?: string }): JSX.Element | null {
  if (!message && !pending && !hint) return null
  return <div className={styles.feedback} data-error={Boolean(message)} aria-busy={pending}>
    <div className={styles.feedbackIcon} aria-hidden="true">{message ? <AlertCircle {...UI_ICON_SM} /> : pending ? <Spinner size="sm" /> : null}</div>
    <div className={styles.feedbackText} role={message ? 'alert' : 'status'} aria-live={message ? 'assertive' : 'polite'} tabIndex={message ? 0 : undefined}>{message.length > 160 ? <details className={styles.errorDetails}><summary>操作未完成 · 查看原因</summary>{message}</details> : message || (pending ? '正在处理，请稍候…' : hint)}</div>
  </div>
}

function Summary({ job }: { job: BackupJob }): JSX.Element | null {
  if (!job.summary) return null
  const { counts, createdAt, appVersion } = job.summary
  return <div className={styles.summary}>
    <p>{counts.libraries} 个媒体库 · {counts.videos} 部影片 · {counts.actresses} 位演员 · {counts.playlists} 个清单 · {counts.images} 张图片</p>
    <p className={styles.hint}>{new Date(createdAt).toLocaleString()} · 版本 {appVersion}</p>
    {job.upgrade && <p>备份副本已从数据库版本 {job.upgrade.fromSchemaVersion} 升级至 {job.upgrade.toSchemaVersion}，原备份文件保持不变。</p>}
  </div>
}
function canRetryTransfer(job: BackupJob): boolean {
  return Boolean(job.transferError) && (job.phase === 'receiving' || (job.kind === 'backup' && job.phase === 'completed'))
}
function taskError(job: BackupJob): string | undefined {
  return job.phase === 'cancelled' ? undefined : job.transferError || job.error
}
function JobSummary({ job }: { job: BackupJob }): JSX.Element | null {
  if (!job.summary) return null
  return <><Summary job={job} />{Boolean(job.summary.missingImages?.length) && <details>
    <summary>已省略 {job.summary.missingImages!.length} 张缺失图片</summary>
    <div className={styles.missingPaths}>{job.summary.missingImages!.map(path => <div className={styles.path} key={path}>{path}</div>)}</div>
  </details>}</>
}

export default function BackupSettingsPanel(): JSX.Element {
  const { session, reconnect } = useDesktopSession()
  const [jobs, setJobs] = useState<BackupJob[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const detailsPrefix = useId()
  const [mappings, setMappings] = useState<BackupMapping[]>([])
  const [step, setStep] = useState(0)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [page, setPage] = useState(0)
  const review = step === 2
  const [omitUnrooted, setOmitUnrooted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ scope: string; message: string } | null>(null)
  const [busyScope, setBusyScope] = useState('')
  const [statusError, setStatusError] = useState('')
  const [pickRoot, setPickRoot] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now)
  const [removing, setRemoving] = useState<BackupJob | null>(null)
  const [removalPlan, setRemovalPlan] = useState<BackupRemovalPreview | null>(null)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const mounted = useRef(true)
  const initialized = useRef(false)
  const loadSequence = useRef(0)
  const bodyRef = useRef<HTMLDivElement>(null)
  const job = jobs.find(item => item.id === selectedId)
  useEffect(() => {
    if (bodyRef.current) { bodyRef.current.scrollTop = 0; bodyRef.current.focus({ preventScroll: true }) }
  }, [step, selectedId, wizardOpen])
  const active = jobs.some(item => runningPhases.has(item.phase) || item.phase === 'ready' || item.phase === 'recoveryRequired' || item.downloading)
  const allowed = session.state === 'available' && !session.frozen
  const target = session.mode === 'remote' ? session.remoteBaseUrl ?? '当前服务端' : '这台电脑的本机资料库'
  const history = jobs.filter(item => item.id !== selectedId)
  const pages = Math.max(1, Math.ceil(history.length / 5))
  const currentPage = Math.min(page, pages - 1)
  useEffect(() => {
    // Only live workflows own the task card. Looking at history never changes it.
    if (!job || !finishedPhases.has(job.phase) || job.downloading || busy) return
    if (!expandedId) {
      setExpandedId(job.id)
      setPage(Math.floor(jobs.findIndex(item => item.id === job.id) / 5))
    }
    setFeedback(current => current?.scope === 'task' ? { ...current, scope: job.id } : current)
    setSelectedId(null); setWizardOpen(false)
  }, [job, jobs, busy, expandedId])
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    try {
      const result = await api.backup.control({ action: 'list' })
      if (mounted.current && sequence === loadSequence.current) {
        setStatusError(''); setJobs(result.jobs)
        if (!initialized.current) {
          initialized.current = true
          setSelectedId(current => current ?? result.jobs.find(job => runningPhases.has(job.phase) || job.phase === 'ready' || job.phase === 'recoveryRequired')?.id ?? null)
        }
      }
    } catch (reason) { if (mounted.current && sequence === loadSequence.current) setStatusError((reason as Error).message) }
  }, [])
  useEffect(() => {
    mounted.current = true
    let pending = false
    const refresh = (): void => { setNow(Date.now()); if (!pending) { pending = true; void load().finally(() => { pending = false }) } }
    refresh()
    const timer = setInterval(refresh, 1500)
    return () => { mounted.current = false; clearInterval(timer) }
  }, [load])
  const perform = async (work: () => Promise<unknown>, scope = 'task'): Promise<void> => {
    setBusy(true); setBusyScope(scope); setFeedback(null)
    try { await work(); await load() } catch (reason) { if (mounted.current) setFeedback({ scope, message: (reason as Error).message }) }
    finally { if (mounted.current) { setBusy(false); setBusyScope('') } }
  }
  const file = (input: DesktopBackupFileRequest, scope = input.action === 'create' ? 'create' : 'restore'): void => { void perform(async () => {
    const result = await api.backup.file(input)
    if (result.job && mounted.current && ['create', 'open', 'importLocal'].includes(input.action)) {
      setJobs(current => [result.job!, ...current.filter(item => item.id !== result.job!.id)])
      setSelectedId(result.job.id); setMappings([]); setStep(0); setAcknowledged(false); setOmitUnrooted(false)
      setWizardOpen(input.action !== 'create')
    }
  }, scope) }
  const command = (input: BackupRequest, scope = 'task'): void => { void perform(async () => { await api.backup.control(input) }, scope) }
  const previewRemoval = (item: BackupJob): void => {
    setRemoving(item); setRemovalPlan(null); setDeleteFiles(false)
    void perform(async () => {
      const result = await api.backup.control({ action: 'previewRemoval', id: item.id })
      if (!result.removal) throw new Error('无法读取删除范围，请更新资料库服务后重试')
      if (mounted.current) { setRemovalPlan(result.removal); setDeleteFiles(Boolean(result.removal.cleanupStarted)) }
    }, item.id)
  }
  const removeRecord = (id: string): void => { if (!removalPlan) return; void perform(async () => {
    await api.backup.control({ action: 'removeRecord', id, deleteFiles, ...(deleteFiles ? { digest: removalPlan.digest } : {}) })
    if (mounted.current) {
      setRemoving(null); setRemovalPlan(null)
      setJobs(current => current.filter(item => item.id !== id))
      setExpandedId(current => current === id ? null : current)
      if (selectedId === id) { setSelectedId(null); setMappings([]); setStep(0); setAcknowledged(false); setOmitUnrooted(false) }
    }
  }, id) }
  const assign = (rootId: number, target: BackupMapping['target']): void => {
    setMappings(current => [...current.filter(item => item.sourceRootId !== rootId), { sourceRootId: rootId, target }]); setAcknowledged(false)
  }
  const chooseDirectory = (rootId: number): void => {
    if (session.mode === 'remote') { setPickRoot(rootId); return }
    void perform(async () => { const result = await api.backup.file({ action: 'pickDirectory' }); if (result.path) assign(rootId, { kind: 'local', path: result.path }) })
  }
  const continueTask = (item: BackupJob): void => {
    if (selectedId !== item.id) { setMappings([]); setStep(0); setAcknowledged(false); setOmitUnrooted(false) }
    setSelectedId(item.id); setWizardOpen(item.phase === 'ready')
  }
  const transfer = (item: BackupJob): string => item.downloading
    ? item.bytes > 0 ? `正在保存到本机：${size(item.downloadedBytes ?? 0)} / ${size(item.bytes)}` : '正在准备备份文件，生成后保存到本机。'
    : item.savedPath ?? ''
  return <div className={styles.root}>
    <div className={styles.target}><div className={styles.targetCopy}><span className={styles.hint}>当前资料库</span><strong>{session.mode === 'remote' ? '服务端资料库' : '本机资料库'}</strong>{session.mode === 'remote' && <span className={styles.path}>{target}</span>}</div><span className={styles.mappingState} data-selected={allowed}>{allowed ? '可备份与恢复' : '连接或写入权限不可用'}</span></div>
    <SettingsCard title="资料操作">
      <div className={styles.entry}>
        <div><strong>创建备份</strong><SettingsFeedback error={feedback?.scope === 'create'} detail={feedback?.scope === 'create' ? feedback.message : null} message={busyScope === 'create' ? '正在准备备份，请稍候…' : feedback?.scope === 'create' ? feedback.message : '保存到这台电脑。备份文件不加密，不包含原始视频。'} /></div>
        <Button variant="primary" disabled={!allowed || busy || active} onClick={() => file({ action: 'create' })}><Archive {...UI_ICON_SM} />创建备份</Button>
      </div>
      <div className={styles.entry}>
        <div><strong>恢复资料</strong><SettingsFeedback error={feedback?.scope === 'restore'} detail={feedback?.scope === 'restore' ? feedback.message : null} message={busyScope === 'restore' ? '正在读取导入来源，请稍候…' : feedback?.scope === 'restore' ? feedback.message : '替换当前资料库；执行前自动备份目标，原始视频不受影响。'} /></div>
        <div className={styles.actions}><Button disabled={!allowed || busy || active} onClick={() => file({ action: 'open' })}><Upload {...UI_ICON_SM} />选择备份文件</Button>{session.mode === 'remote' && <Button disabled={!allowed || busy || active} onClick={() => file({ action: 'importLocal' })}>从本机资料库导入</Button>}</div>
      </div>
      <details className={styles.scope}><summary>备份范围与恢复说明</summary><p className={styles.hint}>包含全部媒体库的正式资料、清单、个人评分和正式图片；不包含原始视频、插件与模型配置、工作记录、待确认事项、运行任务和登录凭据。加密图片只在备份副本中解密，源图片保持原状。</p><p className={styles.hint}>本机资料导入后仍可独立使用，两份资料不自动同步。自动备份保留在目标设备，可在任务详情中另存；本轮不自动清理。</p></details>
      {!allowed && <p className={styles.hint}>请先连接资料库并完成写入授权。</p>}
    </SettingsCard>
    {job && <SettingsCard title={`${job.kind === 'backup' ? '资料库备份' : '恢复资料'} · ${phaseLabels[job.phase]}`}>
      <section aria-label="备份与恢复步骤" className={styles.task}>
        {runningPhases.has(job.phase) && job.phase !== 'awaitingImages' && <JobProgress job={job} now={now} />}
        {job.phase === 'ready' && <p>备份已就绪。请核对来源、对应目录与覆盖影响，再确认恢复。</p>}
        {job.phase === 'awaitingImages' && job.missingImages && <><MissingImages paths={job.missingImages.paths} /><p className={styles.hint}>继续后只清除备份副本中缺失图片的引用，本机原资料保持不变。</p></>}
        {job.phase === 'receiving' && job.bytes > 0 && <p>已上传 {size(job.transferred)} / {size(job.bytes)}</p>}
        {job.phase === 'recoveryRequired' && <p>恢复已提交，连接更新未完成。请重启资料库所在设备上的 Javdex，再查看此任务；不要重复覆盖恢复。</p>}
        {job.phase === 'failed' && <p>操作未完成。请处理失败原因后重新发起。</p>}
        {job.phase === 'cancelled' && <p>操作已取消，原资料库保持可用。</p>}
        {job.phase === 'completed' && <p role="status">{job.kind === 'backup' ? job.downloading ? '备份已生成，正在保存到这台电脑。' : job.savedPath ? '备份已保存到这台电脑。' : '备份已生成，可另存到这台电脑。' : '恢复完成。当前资料库已更新，原目标的自动备份已保留。'}</p>}
        {transfer(job) && <p className={styles.path} role="status">{transfer(job)}</p>}
        {job.summary && <details><summary>备份摘要{job.summary.missingImages?.length ? ` · 已省略 ${job.summary.missingImages.length} 张缺失图片` : ''}</summary><Summary job={job} />{Boolean(job.summary.missingImages?.length) && <div className={styles.missingPaths}>{job.summary.missingImages!.map(path => <div className={styles.path} key={path}>{path}</div>)}</div>}</details>}
        <footer className={styles.footer}>
          {!(wizardOpen && job.phase === 'ready') && <Feedback message={(feedback?.scope === 'task' ? feedback.message : '') || taskError(job)} pending={busyScope === 'task'} />}
          <div className={styles.footerActions}>
            {job.phase === 'ready' && <Button variant="primary" disabled={busy || !allowed} onClick={() => setWizardOpen(true)}>继续恢复</Button>}
            {job.phase === 'awaitingImages' && job.missingImages && <Button variant="primary" disabled={busy} onClick={() => command({ action: 'confirmMissingImages', id: job.id, digest: job.missingImages!.digest })}>确认缺失并继续备份</Button>}
            {canRetryTransfer(job) && <Button disabled={busy} onClick={() => file({ action: 'resume', id: job.id }, 'task')}>重试传输</Button>}
            {job.phase === 'completed' && job.kind === 'backup' && <Button disabled={busy || job.downloading} onClick={() => file({ action: 'save', id: job.id }, 'task')}><Download {...UI_ICON_SM} />另存为</Button>}
            {job.savedPath && <Button disabled={busy} onClick={() => file({ action: 'reveal', id: job.id }, 'task')}><FolderOpen {...UI_ICON_SM} />所在文件夹</Button>}
            {['receiving', 'ready', 'protecting', 'inspecting', 'snapshot', 'awaitingImages', 'packing'].includes(job.phase) && <Button disabled={busy} onClick={() => command({ action: 'cancel', id: job.id })}>取消任务</Button>}
            {job.phase === 'completed' && job.kind === 'restore' && <Button disabled={busy} onClick={() => void perform(reconnect)}>刷新资料库连接</Button>}
          </div>
        </footer>
      </section>
    </SettingsCard>}
    <SettingsCard title={`操作记录 · ${history.length}`} hint="删除时可选择清理 Javdex 托管的备份；手动另存文件保留。">
      <Feedback message={statusError ? `无法更新任务状态：${statusError}。保留上次结果，尚未确认任务停止，请勿重复发起。` : ''} />
      <div className={styles.history}>{history.slice(currentPage * 5, currentPage * 5 + 5).map(item => <div className={styles.record} key={item.id}>
        <div className={styles.recordCopy}><strong>{item.kind === 'backup' ? '资料库备份' : '恢复资料'}</strong><span className={styles.status} data-failed={item.phase === 'failed' || item.phase === 'recoveryRequired'}>{item.downloading ? '正在保存到本机' : phaseLabels[item.phase]}</span><SettingsFeedback
          message={(removing?.id !== item.id && feedback?.scope === item.id ? feedback.message : '') || taskError(item) || (item.downloading ? transfer(item) : busyScope === item.id ? '正在处理，请稍候…' : `${new Date(item.createdAt).toLocaleString()}${item.bytes > 0 ? ` · ${size(item.bytes)}` : ''}${item.savedPath ? ' · 已保存到本机' : ''}`)}
          error={Boolean((removing?.id !== item.id && feedback?.scope === item.id && feedback.message) || taskError(item))}
          detail={(removing?.id !== item.id && feedback?.scope === item.id ? feedback.message : '') || taskError(item) || null}
        /></div>
        <div className={styles.actions}>
          <Button size="sm" variant="ghost" aria-expanded={expandedId === item.id} aria-controls={`${detailsPrefix}-${item.id}`} onClick={() => setExpandedId(current => current === item.id ? null : item.id)}>{expandedId === item.id ? <ChevronDown {...UI_ICON_SM} /> : <ChevronRight {...UI_ICON_SM} />}{expandedId === item.id ? '收起详情' : '展开详情'}</Button>
          {!finishedPhases.has(item.phase) && <Button size="sm" disabled={busy} onClick={() => continueTask(item)}>继续处理</Button>}
          {item.kind === 'backup' && item.phase === 'completed' && <Button size="sm" disabled={busy || item.downloading} onClick={() => file({ action: 'save', id: item.id }, item.id)}><Download {...UI_ICON_SM} />另存为</Button>}
          {['completed', 'failed', 'cancelled'].includes(item.phase) && <Button size="sm" variant="danger" disabled={busy || item.downloading} title="确认删除记录，可选择清理托管备份" onClick={() => previewRemoval(item)}><Trash2 {...UI_ICON_SM} />删除记录</Button>}
        </div>
        {canRetryTransfer(item) && <div className={styles.recordFeedback}><Button size="sm" disabled={busy || item.downloading} onClick={() => file({ action: 'resume', id: item.id }, item.id)}>重试传输</Button></div>}
        <div id={`${detailsPrefix}-${item.id}`} className={styles.recordDetails} hidden={expandedId !== item.id}>
          {expandedId === item.id && <>
            <p className={styles.recordResult}>{item.phase === 'completed' ? item.kind === 'backup' ? item.savedPath ? '备份已保存到这台电脑。' : '备份已生成，可另存到这台电脑。' : '恢复完成。当前资料库已更新，原目标的自动备份已保留。' : item.phase === 'cancelled' ? '操作已取消，原资料库保持可用。' : item.phase === 'failed' ? '操作未完成，请处理失败原因后重新发起。' : '任务尚未结束，可继续处理。'}</p>
            {(item.savedPath || item.fileName) && <div className={styles.recordLocation}><span className={styles.locationLabel}>{item.savedPath ? '本机副本' : '来源文件'}</span><span className={styles.path}>{item.savedPath || item.fileName}</span>{item.savedPath && <Button size="sm" disabled={busy} onClick={() => file({ action: 'reveal', id: item.id }, item.id)}><FolderOpen {...UI_ICON_SM} />所在文件夹</Button>}</div>}
            <JobSummary job={item} />
            {item.phase === 'completed' && item.kind === 'restore' && <div className={styles.actions}><Button size="sm" disabled={busy} onClick={() => void perform(reconnect, item.id)}>刷新资料库连接</Button></div>}
          </>}
        </div>
      </div>)}{history.length === 0 && <p className={styles.empty}>{initialized.current ? job ? '当前任务显示在上方，暂无其他记录。' : '暂无操作记录' : '正在读取操作记录…'}</p>}</div>
      {pages > 1 && <div className={styles.pagination}><span>第 {currentPage + 1} / {pages} 页</span><Button size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button><Button size="sm" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>}
    </SettingsCard>
    {wizardOpen && job?.phase === 'ready' && <Modal title="恢复资料" hint={`目标：${target}`} size="xl" className={styles.wizard} bodyClassName={styles.wizardBody} bodyOverflow="hidden" busy={busy} onCancel={() => setWizardOpen(false)} actions={<div className={styles.wizardFooter}>
      <Feedback message={(feedback?.scope === 'task' ? feedback.message : '') || (statusError ? `暂时无法更新任务状态：${statusError}。请等待连接恢复。` : '')} pending={busyScope === 'task'} />
      <div className={styles.footerActions}><Button disabled={busy} onClick={() => setWizardOpen(false)}>稍后继续</Button>{step > 0 && <Button disabled={busy} onClick={() => { setStep(step - 1); setAcknowledged(false) }}>上一步</Button>}
      {step === 0 && <Button variant="primary" disabled={busy || !job.summary} onClick={() => setStep(1)}>对应资源目录</Button>}
      {step === 1 && <Button variant="primary" disabled={busy || !allowed || mappings.length !== job.summary?.roots.length || Boolean(job.summary?.unrootedResources && !omitUnrooted)} onClick={() => void perform(async () => { await api.backup.control({ action: 'preview', id: job.id, mappings, omitUnrooted }); setStep(2); setAcknowledged(false) })}>核对恢复影响</Button>}
      {review && <Button variant="danger" disabled={busy || !allowed || Boolean(statusError) || !acknowledged || !job.preview || job.preview.blockers.length > 0} onClick={() => void perform(async () => { await api.backup.control({ action: 'restore', id: job.id, digest: job.preview!.digest }); setWizardOpen(false) })}>备份当前资料并恢复</Button>}</div>
    </div>}>
      <ol className={styles.stepper}>{['核对来源', '对应目录', '确认恢复'].map((label, index) => <li className={styles.step} key={label} aria-current={step === index ? 'step' : undefined}><span className={styles.stepNumber}>{index + 1}</span>{label}</li>)}</ol>
      <div ref={bodyRef} className={styles.body} tabIndex={-1}>
        {step === 0 && <><h4>来源备份</h4><Summary job={job} /><p className={styles.path}>{job.fileName}</p><p className={styles.hint}>下一步对应视频所在目录；不会复制或删除原始视频。恢复会替换目标资料库，不会合并两份资料。</p>{Boolean(job.summary?.missingImages?.length) && <><p>此备份已省略 {job.summary!.missingImages!.length} 张图片，恢复不会找回这些图片。</p><details><summary>查看缺失清单</summary><div className={styles.missingPaths}>{job.summary!.missingImages!.map(path => <div key={path} className={styles.path}>{path}</div>)}</div></details></>}</>}
          {step === 1 && <>
            <p className={styles.hint}>为每个来源选择对应的{session.mode === 'remote' ? '服务端挂载' : '本机'}目录。目录对应不会复制视频。</p>
            {Boolean(job.summary?.unrootedResources) && <div className={styles.mapping}><p>有 {job.summary!.unrootedResources} 个本地资源未关联来源目录。恢复时需要舍弃这些资源关联，影片资料仍会保留。</p><Button size="sm" disabled={omitUnrooted} onClick={() => setOmitUnrooted(true)}>{omitUnrooted ? '已确认仅保留资料' : '确认仅保留这些资源的资料'}</Button></div>}
            {job.summary?.roots.length === 0 && <p>此备份没有需要映射的来源目录。</p>}
            {job.summary?.roots.map(root => {
              const mapping = mappings.find(item => item.sourceRootId === root.id)
              const omitted = mapping?.target.kind === 'omit'
              return <div key={root.id} className={styles.mapping} data-selected={Boolean(mapping)}>
                <div className={styles.mappingHeading}><strong>{root.name}</strong><span className={styles.mappingState} data-selected={Boolean(mapping)} role="status">{mapping && <Check {...UI_ICON_SM} />}{omitted ? '已选择 · 仅保留资料' : mapping ? '已对应目录' : '待选择'}</span></div>
                <span className={styles.path}>来源：{root.path}</span>
                {omitted ? <p className={styles.mappingImpact}>恢复时不保留此目录的本地资源关联；影片资料、清单和评分仍会保留，不会删除原始视频。</p> : <span className={styles.path}>{mapping ? `目标：${describeMapping(mapping)}` : '请选择对应目录，或选择仅保留资料。'}</span>}
                <div className={styles.actions}><Button size="sm" disabled={busy} onClick={() => chooseDirectory(root.id)}><FolderOpen {...UI_ICON_SM} />{mapping && !omitted ? '更改目录' : '选择目录'}</Button><Button size="sm" disabled={busy} aria-pressed={omitted} onClick={() => omitted ? setMappings(current => current.filter(item => item.sourceRootId !== root.id)) : assign(root.id, { kind: 'omit' })}>{omitted && <Check {...UI_ICON_SM} />}{omitted ? '已选仅保留资料' : '仅保留资料'}</Button></div>
              </div>
            })}
          </>}
          {review && job.preview && <>
            <p>恢复目标：{session.mode === 'remote' ? session.remoteBaseUrl ?? '当前服务端' : '这台电脑的本机资料库'}</p>
            {job.summary?.roots.map(root => <div className={styles.mapping} key={root.id}><strong>{root.name}</strong><span className={styles.path}>{root.path}</span><span className={styles.path}>恢复处理：{describeMapping(mappings.find(item => item.sourceRootId === root.id))}</span></div>)}
            <p>将替换当前资料库中的 {job.preview.targetCounts.videos} 部影片、{job.preview.targetCounts.actresses} 位演员和 {job.preview.targetCounts.playlists} 个清单。</p>
            <p>移除 {job.preview.removedResources} 条本地资源关联；{job.preview.missingResources} 个资源文件当前无法找到。</p>
            <p className={styles.hint}>这里只检查路径和文件是否存在，不代表视频可以解码播放。缺失或舍弃资源的媒体库将关闭自动清理无资源影片。</p>
            <p>恢复前自动备份目录：<span className={styles.path}>{job.preview.automaticBackupPath}</span></p>
            {job.preview.blockers.length > 0 && <div role="alert"><p>请先处理以下事项，再返回目录设置重新预览。</p><ul>{job.preview.blockers.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
          </>}

        {review && job.preview && <label className={styles.acknowledgment}><Checkbox checked={acknowledged} disabled={busy || job.preview.blockers.length > 0} onChange={event => setAcknowledged(event.target.checked)} />我已核对覆盖范围、目录对应和缺失资源，确认替换当前资料库。</label>}
      </div>
    </Modal>}
    {removing && <Modal title="删除这条操作记录？" size="sm" busy={busy}
      onCancel={() => { setRemoving(null); setRemovalPlan(null) }}
      onConfirm={() => removeRecord(removing.id)} danger confirmText={deleteFiles ? '删除记录及备份' : '删除记录'}
      confirmDisabled={!removalPlan || Boolean(deleteFiles && removalPlan.blockedReason)}>
      <p>{removing.kind === 'backup' ? '资料库备份' : '恢复资料'} · {new Date(removing.createdAt).toLocaleString()}</p>
      {!removalPlan && !busy && <Button size="sm" onClick={() => previewRemoval(removing)}>重新检查删除范围</Button>}
      {removalPlan && <>
        {removalPlan.fileCount > 0 && <label className={styles.acknowledgment}><Checkbox checked={deleteFiles} disabled={busy || Boolean(removalPlan.blockedReason) || removalPlan.cleanupStarted} onChange={event => setDeleteFiles(event.target.checked)} />同时清理{removalPlan.host === 'remote' ? '服务端' : '本机备份区'}的备份及临时文件，释放约 {size(removalPlan.bytes)}</label>}
        {removalPlan.fileCount === 0 && !removalPlan.blockedReason && <p className={styles.hint}>没有需要清理的托管备份文件。</p>}
        {removalPlan.blockedReason && <p className={styles.hint}>{removalPlan.blockedReason}</p>}
        {removalPlan.cleanupStarted && <p className={styles.hint}>上次清理尚未完成，请继续清理；已删除的文件不会恢复。</p>}
        {deleteFiles && <><p className={styles.path}>{removalPlan.location}</p><p className={styles.hint}>仅清理这条记录对应的托管文件，删除后不能撤销。</p></>}
        {removalPlan.automaticBackup && <p className={styles.hint}>这是恢复前生成的自动保护备份。删除文件后，将无法通过它回到覆盖前的资料。</p>}
        {removalPlan.retainedAutomaticBackup && <p className={styles.hint}>本次恢复前的自动保护备份单独保留，不随这条恢复记录删除。</p>}
      </>}
      <p className={styles.hint}>原始备份文件和手动另存的副本将保留。当前资料库及原始视频不受影响。</p>
      <Feedback message={feedback?.scope === removing.id ? feedback.message : ''} pending={busyScope === removing.id} hint={busyScope === removing.id && !removalPlan ? '正在检查删除范围…' : ''} />
    </Modal>}
    {pickRoot !== null && <RemoteRootPicker title="选择目标资源目录" confirmText="使用此目录" busy={false} available={allowed} onCancel={() => setPickRoot(null)} onAdd={target => { assign(pickRoot, { kind: 'mount', ...target }); setPickRoot(null) }} />}
  </div>
}
