import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { FileOutput, LoaderCircle, OctagonX } from 'lucide-react'
import type {
  NfoExportCollisionPolicy,
  NfoExportOptions,
  NfoExportPlanPreview,
  NfoExportPreferences,
  NfoExportProgressEvent,
  NfoExportReport,
  NfoExportStateEvent
} from '@shared/nfoExportTypes'
import { api } from '../../api'
import Button from '../Button'
import SelectControl from '../SelectControl'
import { AppFormField } from '../FormPrimitives'
import { UI_ICON_SM } from '../iconDefaults'
import { shouldBlockNfoExportShortcut } from '@shared/nfoExportForegroundGuard'
import { SettingsCard, SettingsStatusPill } from './SettingsPrimitives'
import styles from './NfoExportPanel.module.css'

export interface ExportModalState {
  taskId: string
  progress: NfoExportProgressEvent | null
  report: NfoExportReport | null
  terminating: boolean
  error?: string
}

export default function NfoExportPanel({
  disabled,
  onBlockingChange
}: {
  disabled: boolean
  onBlockingChange: (blocking: boolean) => void
}): JSX.Element {
  const [options, setOptions] = useState<NfoExportOptions | null>(null)
  const [draft, setDraft] = useState<NfoExportPreferences | null>(null)
  const [collisionPolicy, setCollisionPolicy] = useState<NfoExportCollisionPolicy>('skip')
  const [preview, setPreview] = useState<NfoExportPlanPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [previewChanged, setPreviewChanged] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modal, setModal] = useState<ExportModalState | null>(null)
  const blocking = modal != null
  const previewRef = useRef<NfoExportPlanPreview | null>(null)
  const runningRef = useRef(false)
  const mountedRef = useRef(true)
  const taskIdRef = useRef<string | null>(null)
  const previewButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    let disposed = false
    void api.nfoExport.getOptions().then((value) => {
      if (disposed) return
      setOptions(value)
      setDraft(value.preferences)
    }, (reason: unknown) => {
      if (!disposed) setError((reason as Error).message)
    })
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    previewRef.current = preview
  }, [preview])

  useEffect(() => {
    const offProgress = api.nfoExport.onProgress((event) => {
      taskIdRef.current = event.taskId
      setModal((current) => current && (current.taskId === 'pending' || current.taskId === event.taskId)
        ? { ...current, taskId: event.taskId, progress: event }
        : current)
    })
    const offState = api.nfoExport.onState((event: NfoExportStateEvent) => {
      if (event.state !== 'finished') return
      runningRef.current = false
      taskIdRef.current = null
      setModal((current) => current && (current.taskId === 'pending' || current.taskId === event.taskId)
        ? { ...current, taskId: event.taskId, report: event.report, terminating: false, error: undefined }
        : current)
    })
    return () => { offProgress(); offState() }
  }, [])

  useEffect(() => () => {
    if (runningRef.current && taskIdRef.current) {
      void api.nfoExport.terminate(taskIdRef.current).catch(() => undefined)
    } else if (!runningRef.current && previewRef.current) {
      void api.nfoExport.discardPlan(previewRef.current.planId).catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    onBlockingChange(blocking)
    if (!blocking || typeof document === 'undefined') return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previewButton = previewButtonRef.current
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    const dialog = document.querySelector<HTMLElement>('[data-nfo-export-modal]')
    dialog?.focus()
    const keepInputInsideModal = (event: KeyboardEvent): void => {
      if (event.key === 'Tab' && dialog) {
        const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), summary, [tabindex="0"]'))
          .filter((element) => element.getClientRects().length > 0)
        const first = controls[0]
        const last = controls.at(-1)
        if (!first || !dialog.contains(document.activeElement) || document.activeElement === dialog
          || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault()
          const target = event.shiftKey ? last : first
          target?.focus()
          if (!first) dialog.focus()
        }
        event.stopImmediatePropagation()
        return
      }
      if (event.key === 'Escape' || shouldBlockNfoExportShortcut({
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey
      })) {
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      if (dialog && event.target instanceof Node && dialog.contains(event.target)) return
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', keepInputInsideModal, true)
    window.addEventListener('beforeunload', preventNfoExportUnload)
    return () => {
      root?.removeAttribute('inert')
      window.removeEventListener('keydown', keepInputInsideModal, true)
      window.removeEventListener('beforeunload', preventNfoExportUnload)
      onBlockingChange(false)
      if (previousFocus?.isConnected && !previousFocus.matches(':disabled')) previousFocus.focus()
      else previewButton?.focus()
    }
  }, [blocking, onBlockingChange])

  const invalidatePreview = (): void => {
    if (preview) {
      void api.nfoExport.discardPlan(preview.planId).catch(() => undefined)
      setPreview(null)
      setPreviewChanged(true)
    }
  }

  const updateDraft = (patch: Partial<NfoExportPreferences>): void => {
    if (!draft) return
    const next = { ...draft, ...patch }
    invalidatePreview()
    setDraft(next)
    setError(null)
    void api.nfoExport.updatePreferences(next).catch((reason: unknown) => {
      setError((reason as Error).message)
    })
  }

  const generatePlan = async (): Promise<void> => {
    if (!draft || draft.libraryIds.length === 0) {
      setError('请选择至少一个媒体库。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (preview) await api.nfoExport.discardPlan(preview.planId)
      const next = await api.nfoExport.plan({ ...draft, collisionPolicy })
      if (!mountedRef.current) {
        await api.nfoExport.discardPlan(next.planId).catch(() => undefined)
        return
      }
      setPreview(next)
      setPreviewChanged(false)
    } catch (reason) {
      setPreview(null)
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const start = async (): Promise<void> => {
    if (!preview) return
    setBusy(true)
    setError(null)
    runningRef.current = true
    setModal({ taskId: 'pending', progress: null, report: null, terminating: false })
    try {
      const result = await api.nfoExport.start(preview.planId)
      taskIdRef.current = result.taskId
      if (!mountedRef.current) {
        await api.nfoExport.terminate(result.taskId).catch(() => undefined)
        return
      }
      setModal((current) => current
        ? { ...current, taskId: result.taskId }
        : { taskId: result.taskId, progress: null, report: null, terminating: false })
    } catch (reason) {
      runningRef.current = false
      taskIdRef.current = null
      setModal(null)
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const terminate = async (): Promise<void> => {
    if (!modal || modal.report) return
    setModal({ ...modal, terminating: true, error: undefined })
    try {
      await api.nfoExport.terminate(modal.taskId)
    } catch (reason) {
      setModal((current) => current && !current.report
        ? { ...current, terminating: false, error: `未能停止任务：${(reason as Error).message}。请重试。` }
        : current)
    }
  }

  const closeReport = (): void => {
    if (!modal?.report) return
    setModal(null)
    setPreview(null)
    taskIdRef.current = null
    setCollisionPolicy('skip')
  }

  const runnableCount = preview
    ? preview.summary.createCount + preview.summary.replaceCount
    : 0
  const selectedProfile = options?.profiles.find((profile) => profile.id === draft?.profileId)
  const selectedExtras = [draft?.includeSamples ? '样张备份' : '', draft?.includeActorAvatars ? '演员头像' : ''].filter(Boolean)
  const unverifiedAvatars = draft?.includeActorAvatars
    && draft.profileId !== 'portable-v1' && draft.profileId !== 'emby-kodi-conservative'

  return (
    <>
      <SettingsCard
        className={styles.root}
        title="导出影片资料（NFO）"
        hint="将已有影片资料和图片保存到视频旁，供支持本地资料的播放器读取。"
        actions={<SettingsStatusPill status={preview ? 'info' : 'muted'}>{preview ? '已预览' : previewChanged ? '待重新预览' : '待预览'}</SettingsStatusPill>}
      >
        {!options || !draft ? (
          <p className={error ? styles.error : styles.muted} role={error ? 'alert' : undefined}>
            {error || '正在读取媒体库与兼容格式…'}
          </p>
        ) : (
          <div className={styles.form} aria-busy={busy}>
            <p className={styles.muted}>一次性导出，不自动同步。</p>
            <fieldset className={styles.fieldset} disabled={disabled || busy}>
              <legend className={styles.fieldLabel}>媒体库</legend>
              <div className={styles.libraryGrid}>
                {options.libraries.length === 0 ? <span className={styles.muted}>暂无可用媒体库</span> : null}
                {options.libraries.map((library) => (
                  <label key={library.id} className={styles.checkRow}>
                    <input
                      type="checkbox"
                      checked={draft.libraryIds.includes(library.id)}
                      onChange={(event) => updateDraft({
                        libraryIds: event.target.checked
                          ? [...draft.libraryIds, library.id]
                          : draft.libraryIds.filter((id) => id !== library.id)
                      })}
                    />
                    <span>{library.name}</span>
                  </label>
                ))}
              </div>
              {draft.libraryIds.length === 0 ? <p className={styles.muted}>先选择要导出的媒体库。</p> : null}
            </fieldset>

            <div className={styles.optionGrid}>
              <AppFormField label="目标软件" hint={selectedProfile?.warning || (draft.profileId === 'portable-v1' ? '不确定时可先选通用 / Kodi，具体支持范围见导出说明。' : selectedProfile?.description)}>
                <SelectControl
                  aria-label="目标软件"
                  value={draft.profileId}
                  disabled={disabled || busy}
                  onChange={(event) => updateDraft({ profileId: event.target.value as NfoExportPreferences['profileId'] })}
                >
                  {options.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
                </SelectControl>
              </AppFormField>
              <AppFormField label="已有文件" hint={collisionPolicy === 'replace' ? '仅覆盖预览中列出的同名文件，请先核对数量与明细。' : '保留视频旁已有的资料和图片，只补充缺少的文件。'}>
                <SelectControl
                  aria-label="已有文件"
                  value={collisionPolicy}
                  disabled={disabled || busy}
                  onChange={(event) => {
                    invalidatePreview()
                    setCollisionPolicy(event.target.value as NfoExportCollisionPolicy)
                  }}
                >
                  <option value="skip">保留已有文件（推荐）</option>
                  <option value="replace">覆盖同名文件</option>
                </SelectControl>
              </AppFormField>
            </div>

            <fieldset className={styles.fieldset} disabled={disabled || busy}>
              <legend className={styles.fieldLabel}>导出内容</legend>
              <p className={styles.requiredContent}>影片资料（NFO）始终导出<span className={styles.muted}> · 包含演员名单</span></p>
              <div className={styles.toggles}>
                {([
                  ['includeCover', '影片封面'],
                  ['includeFanart', '详情背景']
                ] as const).map(([key, label]) => (
                  <label key={key} className={styles.checkRow}>
                    <input
                      type="checkbox"
                      checked={draft[key]}
                      onChange={(event) => updateDraft({ [key]: event.target.checked })}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <details className={styles.disclosure}>
              <summary className={styles.fileSummary}>更多图片<span className={styles.disclosureHint}> · {selectedExtras.length ? `已选${selectedExtras.join('、')}` : '可选附件'}</span></summary>
              <fieldset className={styles.extraOptions} aria-label="更多图片" disabled={disabled || busy}>
                {([
                  ['includeSamples', '样张备份', '供 Javdex 备份、迁移和回读，不作为播放器画廊。'],
                  ['includeActorAvatars', '演员头像', '供 Javdex 回读及 Kodi / Emby 本地头像使用。']
                ] as const).map(([key, label, hint]) => (
                  <label key={key} className={styles.checkRow}>
                    <input type="checkbox" checked={draft[key]} onChange={(event) => updateDraft({ [key]: event.target.checked })} />
                    <span>{label}<small className={styles.optionHint}>{hint}</small></span>
                  </label>
                ))}
              </fieldset>
            </details>
            {unverifiedAvatars ? <p className={styles.muted}>当前目标软件的本地演员头像兼容性尚未验证；头像仍可供 Javdex 回读。</p> : null}
            <details className={styles.disclosure}>
              <summary className={styles.fileSummary}>导出说明与文件示例</summary>
              <div className={styles.helpContent}>
                <p>{selectedProfile?.description}</p>
                <p>封面：横版保留原图，并从右侧裁剪 2:3 竖版海报；竖版只导出海报。详情背景使用已有背景图片。</p>
                <p>样张单独保存到 javdex-samples；头像保存到 .actors。不同播放器支持的字段和图片可能不同。</p>
                <p>文件示例（以 JPG 图片为例，实际名称见预览）：</p>
                <ul>
                  <li>影片资料：ABC-001.nfo</li>
                  <li>竖版海报：{draft.profileId === 'infuse-current' ? 'ABC-001.jpg' : 'ABC-001-poster.jpg'}；横版原图：ABC-001-landscape.jpg</li>
                  <li>详情背景：ABC-001-fanart.jpg</li>
                  <li>样张备份：javdex-samples/ABC-001-001.jpg；演员头像：.actors/演员名.jpg</li>
                </ul>
                <p>文件保存在本地视频或 STRM 文件旁；没有这些本地文件的资源会跳过。源视频不会被移动或修改。</p>
              </div>
            </details>
            {error ? <p className={styles.error} role="alert">{error}</p> : null}

            {preview ? <PlanPreview key={preview.planId} preview={preview} /> : null}

            <footer className={styles.footer}>
              <p className={styles.muted} role="status">
                {previewChanged ? '设置已更改，请重新预览。' : preview ? runnableCount > 0 ? '核对预览后开始导出。' : '调整选项后可重新预览。' : '先预览文件和数量，再开始导出。'}
              </p>
              <div className={styles.actions}>
                <Button ref={previewButtonRef} className={styles.actionButton} variant={preview ? 'default' : 'primary'} size="sm" disabled={disabled || busy || draft.libraryIds.length === 0} onClick={() => void generatePlan()}>
                  <FileOutput {...UI_ICON_SM} aria-hidden />
                  {busy && !modal ? '正在预览…' : preview ? '重新预览' : '预览导出'}
                </Button>
                {preview ? (
                  <Button className={styles.actionButton} variant="primary" size="sm" disabled={disabled || busy || runnableCount === 0} onClick={() => void start()}>
                    {runnableCount > 0 ? `导出 ${runnableCount} 个文件` : '暂无可导出文件'}
                  </Button>
                ) : null}
              </div>
            </footer>
          </div>
        )}
      </SettingsCard>
      {modal && typeof document !== 'undefined'
        ? createPortal(
            <ExportProgressModal modal={modal} onTerminate={terminate} onClose={closeReport} />,
            document.body
          )
        : null}
    </>
  )
}

export function preventNfoExportUnload(event: BeforeUnloadEvent): void {
  event.preventDefault()
  event.returnValue = ''
}

const fileKindLabels = {
  nfo: 'NFO', cover: '竖版海报', landscape: '横版封面', fanart: '详情背景', sample: '样张备份', 'actor-avatar': '演员头像'
} satisfies Record<NfoExportPlanPreview['files'][number]['kind'], string>

const actionLabels = {
  create: '新建', replace: '覆盖', 'skip-existing': '跳过已有', conflict: '冲突', unavailable: '不可用'
} satisfies Record<NfoExportPlanPreview['files'][number]['action'], string>

const dispositionLabels = {
  written: '已写入', 'skipped-existing': '已跳过', 'stale-plan': '预览已过期',
  conflict: '冲突', failed: '失败', cancelled: '已取消', unavailable: '不可用'
} satisfies Record<NfoExportReport['items'][number]['disposition'], string>

/** Keep large export lists unmounted until opened, and render at most one page. */
function ExportDetails({ title, count, defaultOpen = false, children }: {
  title: string
  count: number
  defaultOpen?: boolean
  children: (start: number, end: number) => ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const [page, setPage] = useState(0)
  const pageSize = 50
  const start = page * pageSize
  const end = Math.min(start + pageSize, count)
  const scrollRef = useRef<HTMLDivElement>(null)
  const changePage = (next: number): void => {
    setPage(next)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }
  return (
    <details className={styles.fileList} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={styles.fileSummary}>{title}</summary>
      {open ? (
        <>
          <div ref={scrollRef} className={styles.fileTable}>{children(start, end)}</div>
          {count > pageSize ? (
            <div className={styles.pagination}>
              <span aria-live="polite">{start + 1}–{end} / {count} 条</span>
              <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => changePage(page - 1)}>上一页</Button>
              <Button size="sm" variant="ghost" disabled={end >= count} onClick={() => changePage(page + 1)}>下一页</Button>
            </div>
          ) : null}
        </>
      ) : null}
    </details>
  )
}

export function PlanPreview({ preview }: { preview: NfoExportPlanPreview }): JSX.Element {
  const summary = preview.summary
  const writableCount = summary.createCount + summary.replaceCount
  const writingKinds = new Map<NfoExportPlanPreview['files'][number]['kind'], number>()
  for (const file of preview.files) {
    if (file.action === 'create' || file.action === 'replace') {
      writingKinds.set(file.kind, (writingKinds.get(file.kind) || 0) + 1)
    }
  }
  const allPreserved = summary.skipCount > 0 && summary.skipCount === summary.fileCount
    && summary.skippedNoAnchorCount === 0
  return (
    <section className={styles.preview} aria-label="NFO 导出计划预览">
      <div className={styles.previewHeading}>
        <strong className={styles.previewTotal}>{summary.videoCount} 部影片 · {writableCount > 0 ? `将写入 ${writableCount} 个文件` : allPreserved ? '无需写入' : '暂无可写入文件'}</strong>
        {writableCount > 0 ? <span className={styles.muted}>约 {formatBytes(summary.estimatedBytes)}</span> : null}
      </div>
      <div className={styles.summaryStats}>
        {[
          ['新建', summary.createCount],
          ['覆盖', summary.replaceCount], ['保留已有', summary.skipCount]
        ].filter(([, value]) => Number(value) > 0).map(([label, value]) => (
          <span key={label}>{label} <strong>{value}</strong></span>
        ))}
      </div>
      {writableCount > 0 ? (
        <p className={styles.muted} aria-label="本次写入组成">本次写入：{Array.from(writingKinds, ([kind, count]) => `${kind === 'nfo' ? '影片资料' : fileKindLabels[kind]} ${count}`).join(' · ')}</p>
      ) : (
        <p className={styles.muted}>{allPreserved
          ? '已有文件已保留。如需更新资料或海报，请选择“覆盖同名文件”后重新预览。'
          : '请查看下方提示，确认资源有本地文件且所需资料可用。'}</p>
      )}
      <p className={styles.muted}>位置：各影片的本地视频或 STRM 文件所在文件夹。</p>
      {summary.conflictCount > 0 || summary.unavailableCount > 0 || summary.skippedNoAnchorCount > 0 ? (
        <div className={styles.summaryStats}>
          {summary.conflictCount > 0 ? <span className={styles.warning}>冲突 {summary.conflictCount} 个文件</span> : null}
          {summary.unavailableCount > 0 ? <span className={styles.warning}>不可用 {summary.unavailableCount} 个文件</span> : null}
          {summary.skippedNoAnchorCount > 0 ? <span>无本地视频或 STRM 文件，跳过 {summary.skippedNoAnchorCount} 个资源</span> : null}
        </div>
      ) : null}
      {preview.warnings.length > 0 ? (
        <ExportDetails title={`导出提示 · ${preview.warnings.length} 条`} count={preview.warnings.length}>
          {(start, end) => (
            <ul className={styles.warningList}>
              {preview.warnings.slice(start, end).map((warning, index) => <li key={start + index}>{warning}</li>)}
            </ul>
          )}
        </ExportDetails>
      ) : null}
      <ExportDetails title={`文件明细 · ${preview.files.length} 个`} count={preview.files.length}>
        {(start, end) => <>
          <p className={styles.detailCaption}>{summary.resourceCount} 个资源 · 共 {summary.fileCount} 个文件（含保留及无法写入的文件）</p>
          {preview.files.slice(start, end).map((file) => (
          <div key={file.id} className={styles.fileRow}>
            <span className={styles.fileName}>{file.displayName}{file.warning ? ` — ${file.warning}` : ''}</span>
            <span className={styles.fileMeta}>{fileKindLabels[file.kind]}</span>
            <strong className={styles.fileDisposition} data-action={file.action}>{actionLabels[file.action]}</strong>
          </div>
          ))}
        </>}
      </ExportDetails>
    </section>
  )
}

export function ExportProgressModal({
  modal,
  onTerminate,
  onClose
}: {
  modal: ExportModalState
  onTerminate: () => Promise<void>
  onClose: () => void
}): JSX.Element {
  const progress = modal.progress
  const report = modal.report
  const reportTitle = report
    ? report.terminated ? '已停止导出'
      : report.writtenCount === 0 ? '未写入文件'
        : report.failedCount > 0 ? '部分导出完成' : '导出完成'
    : '正在导出影片资料'
  const percent = progress?.total ? Math.round((progress.completed / progress.total) * 100) : 0
  return (
    <div className={styles.backdrop}>
      <section
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="nfo-export-modal-title"
        data-nfo-export-modal
        tabIndex={-1}
      >
        <header className={styles.modalHeader}>
          <span className={styles.modalIcon} aria-hidden>{report ? <FileOutput {...UI_ICON_SM} /> : <LoaderCircle {...UI_ICON_SM} />}</span>
          <div>
            <h3 className={styles.modalTitle} id="nfo-export-modal-title">{reportTitle}</h3>
            <p className={styles.modalText}>{report ? (report.terminated ? '已写入的文件保留，其余文件未继续写入。' : report.failedCount > 0 ? '部分文件未能写入，请查看下方原因。' : report.writtenCount === 0 ? '没有新增或覆盖文件，请查看逐项结果。' : '影片资料和所选图片已保存到对应文件夹。') : '导出期间请保持应用打开，其它操作暂时锁定。'}</p>
          </div>
        </header>
        {!report ? (
          <>
            <progress className={styles.modalProgress} max={progress?.total || 1} value={progress?.completed || 0} />
            <div className={styles.progressCopy}>
              <span className={styles.progressName}>{progress?.current?.displayName || '准备写入…'}</span>
              <strong>{progress?.completed || 0} / {progress?.total || 0} · {percent}%</strong>
            </div>
            {modal.error ? <p className={styles.error} role="alert">{modal.error}</p> : null}
            <Button className={styles.modalAction} variant="danger" disabled={modal.terminating || modal.taskId === 'pending'} onClick={() => void onTerminate()}>
              <OctagonX {...UI_ICON_SM} aria-hidden />
              {modal.terminating ? '正在停止…' : modal.error ? '重试停止' : '停止导出'}
            </Button>
          </>
        ) : (
          <>
            <div className={styles.reportSummary}>
              <span>写入 <strong>{report.writtenCount}</strong></span>
              <span>跳过 / 未执行 <strong>{report.skippedCount}</strong></span>
              <span>未能写入 <strong>{report.failedCount}</strong></span>
            </div>
            <ExportDetails title={`逐项结果 · ${report.items.length} 个`} count={report.items.length} defaultOpen={report.failedCount > 0}>
              {(start, end) => report.items.slice(start, end).map((item) => (
                <div key={item.id} className={styles.fileRow}>
                  <span className={styles.fileName}>{item.displayName}{item.message ? ` — ${item.message}` : ''}</span>
                  <span className={styles.fileMeta}>{fileKindLabels[item.kind]}</span>
                  <strong className={styles.fileDisposition} data-action={item.disposition}>{dispositionLabels[item.disposition]}</strong>
                </div>
              ))}
            </ExportDetails>
            {report.writtenCount > 0 ? <p className={styles.muted}>可前往目标软件刷新本地资料或图片，让导出内容生效。</p> : null}
            <Button className={styles.modalAction} variant="primary" onClick={onClose}>完成</Button>
          </>
        )}
      </section>
    </div>
  )
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}
