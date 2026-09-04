import { useEffect, useRef, useState } from 'react'
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
import { UI_ICON_SM } from '../iconDefaults'
import { shouldBlockNfoExportShortcut } from '@shared/nfoExportForegroundGuard'
import { SettingsCard, SettingsStatusPill } from './SettingsPrimitives'
import styles from './NfoExportPanel.module.css'

export interface ExportModalState {
  taskId: string
  progress: NfoExportProgressEvent | null
  report: NfoExportReport | null
  terminating: boolean
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
  const [error, setError] = useState<string | null>(null)
  const [modal, setModal] = useState<ExportModalState | null>(null)
  const blocking = modal != null
  const previewRef = useRef<NfoExportPlanPreview | null>(null)
  const runningRef = useRef(false)
  const mountedRef = useRef(true)
  const taskIdRef = useRef<string | null>(null)

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
        ? { ...current, taskId: event.taskId, report: event.report, terminating: false }
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
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    const dialog = document.querySelector<HTMLElement>('[data-nfo-export-modal]')
    dialog?.focus()
    const keepInputInsideModal = (event: KeyboardEvent): void => {
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
    }
  }, [blocking, onBlockingChange])

  const updateDraft = (patch: Partial<NfoExportPreferences>): void => {
    if (!draft) return
    const next = { ...draft, ...patch }
    if (preview) {
      void api.nfoExport.discardPlan(preview.planId).catch(() => undefined)
      setPreview(null)
    }
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
    setModal({ ...modal, terminating: true })
    try {
      await api.nfoExport.terminate(modal.taskId)
    } catch (reason) {
      setModal((current) => current ? { ...current, terminating: false } : null)
      setError((reason as Error).message)
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

  return (
    <>
      <SettingsCard
        className={styles.root}
        title="NFO 导出"
        hint="为所选媒体库生成一次性本地 NFO 与图片快照；不会建立同步关系或保存导出清单。"
        actions={<SettingsStatusPill status={preview ? 'info' : 'muted'}>{preview ? '计划已生成' : '未规划'}</SettingsStatusPill>}
      >
        {!options || !draft ? (
          <p className={error ? styles.error : styles.muted} role={error ? 'alert' : undefined}>
            {error || '正在读取可用媒体库与兼容 profile…'}
          </p>
        ) : (
          <div className={styles.form} aria-busy={busy}>
            <fieldset className={styles.fieldset} disabled={disabled || busy}>
              <legend className={styles.fieldLabel}>媒体库</legend>
              <div className={styles.libraryGrid}>
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
            </fieldset>

            <div className={styles.optionGrid}>
              <label className={styles.control}>
                <span className={styles.controlLabel}>兼容 Profile</span>
                <select
                  className={styles.select}
                  value={draft.profileId}
                  disabled={disabled || busy}
                  onChange={(event) => updateDraft({ profileId: event.target.value as NfoExportPreferences['profileId'] })}
                >
                  {options.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
                </select>
                <small className={styles.muted}>
                  {options.profiles.find((profile) => profile.id === draft.profileId)?.description}
                </small>
              </label>
              <label className={styles.control}>
                <span className={styles.controlLabel}>已有文件</span>
                <select
                  className={styles.select}
                  value={collisionPolicy}
                  disabled={disabled || busy}
                  onChange={(event) => {
                    if (preview) {
                      void api.nfoExport.discardPlan(preview.planId).catch(() => undefined)
                      setPreview(null)
                    }
                    setCollisionPolicy(event.target.value as NfoExportCollisionPolicy)
                  }}
                >
                  <option value="skip">跳过（默认）</option>
                  <option value="replace">覆盖计划中的文件</option>
                </select>
              </label>
            </div>

            <div className={styles.toggles}>
              {([
                ['includeCover', '影片封面'],
                ['includeFanart', '详情背景'],
                ['includeSamples', '样张'],
                ['includeActorAvatars', '演员头像']
              ] as const).map(([key, label]) => (
                <label key={key} className={styles.checkRow}>
                  <input
                    type="checkbox"
                    checked={draft[key]}
                    disabled={disabled || busy}
                    onChange={(event) => updateDraft({ [key]: event.target.checked })}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>

            {options.profiles.find((profile) => profile.id === draft.profileId)?.warning ? (
              <p className={styles.warning}>{options.profiles.find((profile) => profile.id === draft.profileId)?.warning}</p>
            ) : null}
            {error ? <p className={styles.error} role="alert">{error}</p> : null}

            <div className={styles.actions}>
              <Button className={styles.actionButton} size="sm" disabled={disabled || busy} onClick={() => void generatePlan()}>
                <FileOutput {...UI_ICON_SM} aria-hidden />
                {preview ? '重新生成计划' : '生成计划'}
              </Button>
              {preview ? (
                <Button className={styles.actionButton} variant="primary" size="sm" disabled={disabled || busy || runnableCount === 0} onClick={() => void start()}>
                  执行 {runnableCount} 个写入项
                </Button>
              ) : null}
            </div>

            {preview ? <PlanPreview preview={preview} /> : null}
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

function PlanPreview({ preview }: { preview: NfoExportPlanPreview }): JSX.Element {
  const summary = preview.summary
  return (
    <section className={styles.preview} aria-label="NFO 导出计划预览">
      <div className={styles.summaryGrid}>
        {[
          ['影片', summary.videoCount], ['资源', summary.resourceCount], ['文件', summary.fileCount],
          ['新建', summary.createCount],
          ['覆盖', summary.replaceCount], ['跳过', summary.skipCount], ['冲突', summary.conflictCount],
          ['不可用', summary.unavailableCount], ['警告', summary.warningCount], ['样张', summary.sampleCount]
        ].map(([label, value]) => (
          <span key={label} className={styles.summaryItem}>
            <small className={styles.summaryLabel}>{label}</small>
            <strong className={styles.summaryValue}>{value}</strong>
          </span>
        ))}
      </div>
      <p className={styles.muted}>预计写入 {formatBytes(summary.estimatedBytes)}；无本地锚点跳过 {summary.skippedNoAnchorCount} 个。</p>
      {preview.warnings.length > 0 ? (
        <ul className={styles.warningList}>{preview.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>
      ) : null}
      <details className={styles.fileList}>
        <summary className={styles.fileSummary}>查看全部 {preview.files.length} 个计划文件</summary>
        <div className={styles.fileTable}>
          {preview.files.map((file, index) => (
            <div key={file.id} className={`${styles.fileRow}${index === preview.files.length - 1 ? ` ${styles.fileRowLast}` : ''}`}>
              <span className={styles.fileName}>{file.displayName}</span>
              <code className={styles.fileMeta}>{file.kind}</code>
              <strong className={`${styles.fileMeta} ${styles.fileDisposition}`} data-action={file.action}>{file.action}</strong>
            </div>
          ))}
        </div>
      </details>
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
            <h3 className={styles.modalTitle} id="nfo-export-modal-title">{report ? 'NFO 导出完成' : '正在导出 NFO'}</h3>
            <p className={styles.modalText}>{report ? (report.terminated ? '任务已终止，已完成的文件保留。' : '一次性导出任务已经结束。') : '完成或明确终止前，应用其它操作暂时锁定。'}</p>
          </div>
        </header>
        {!report ? (
          <>
            <progress className={styles.modalProgress} max={progress?.total || 1} value={progress?.completed || 0} />
            <div className={styles.progressCopy}>
              <span className={styles.progressName}>{progress?.current?.displayName || '准备写入…'}</span>
              <strong>{progress?.completed || 0} / {progress?.total || 0} · {percent}%</strong>
            </div>
            <Button variant="danger" disabled={modal.terminating || modal.taskId === 'pending'} onClick={() => void onTerminate()}>
              <OctagonX {...UI_ICON_SM} aria-hidden />
              {modal.terminating ? '正在终止…' : '终止任务'}
            </Button>
          </>
        ) : (
          <>
            <div className={styles.reportSummary}>
              <span>写入 <strong>{report.writtenCount}</strong></span>
              <span>跳过 <strong>{report.skippedCount}</strong></span>
              <span>失败/过期 <strong>{report.failedCount}</strong></span>
            </div>
            <details className={styles.fileList} open={report.failedCount > 0}>
              <summary className={styles.fileSummary}>查看逐项结果</summary>
              <div className={styles.fileTable}>
                {report.items.map((item, index) => (
                  <div key={item.id} className={`${styles.fileRow}${index === report.items.length - 1 ? ` ${styles.fileRowLast}` : ''}`}>
                    <span className={styles.fileName}>{item.displayName}{item.message ? ` — ${item.message}` : ''}</span>
                    <code className={styles.fileMeta}>{item.kind}</code>
                    <strong className={`${styles.fileMeta} ${styles.fileDisposition}`}>{item.disposition}</strong>
                  </div>
                ))}
              </div>
            </details>
            <Button variant="primary" onClick={onClose}>确认并关闭</Button>
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
