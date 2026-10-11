import { useContext, useEffect, useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Circle, CircleAlert, Copy, Undo2 } from 'lucide-react'
import Button from '../Button'
import { UI_ICON_SM } from '../iconDefaults'
import { SettingsSaveDetailsContext } from './SettingsSaveDetailsScope'
import styles from './SettingsFormActions.module.css'

function errorReason(error: string): string {
  if (/EACCES|EPERM|EROFS|permission denied|read-only/i.test(error)) return '无法写入配置，请检查目标目录的读写权限。'
  if (/ENOSPC|disk full/i.test(error)) return '磁盘空间不足，请释放空间后重试。'
  if (/timeout|timed out|ETIMEDOUT/i.test(error)) return '保存请求超时，请检查连接后重试。'
  if (/ECONN|network|failed to fetch|HTTP 50[234]/i.test(error)) return '无法完成保存请求，请检查连接或稍后重试。'
  const firstLine = error.split('\n')[0].trim()
  return /[\u4e00-\u9fff]/.test(firstLine) ? firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine : '未能保存当前配置，请查看技术详情。'
}

function SaveDetails({ id, error, conflict }: { id: string; error?: string | null; conflict?: boolean }): JSX.Element {
  const [copyStatus, setCopyStatus] = useState('复制')
  const technical = error?.trim()
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(technical ?? '')
      setCopyStatus('已复制')
    } catch {
      setCopyStatus('复制失败')
    }
  }
  return <section id={id} className={styles.details} data-conflict={Boolean(conflict)} aria-label={conflict ? '配置冲突详情' : '保存错误详情'}>
    <div className={styles.detailHeading}><CircleAlert {...UI_ICON_SM} className={styles.detailIcon} data-conflict={Boolean(conflict)} aria-hidden /><h4>{conflict ? '已保存的配置发生变化' : '配置未能保存'}</h4></div>
    <p className={styles.reason}>{conflict ? '其他位置已更新这组配置。当前修改已保留。' : `${errorReason(error ?? '')} 当前修改已保留。`}</p>
    <p className={styles.suggestion}>{conflict ? '请先记录需要保留的修改，再点击撤销读取最新配置，核对后重新修改并保存。' : '可点击保存操作重试，或撤销更改恢复已保存的配置。'}</p>
    {technical ? <details className={styles.technical}>
      <summary><ChevronDown {...UI_ICON_SM} className={styles.technicalChevron} aria-hidden />技术详情</summary>
      <Button size="sm" variant="ghost" className={styles.copy} onClick={() => void copy()} aria-label="复制技术详情" title={copyStatus}>
        <Copy {...UI_ICON_SM} aria-hidden /><span aria-live="polite">{copyStatus}</span>
      </Button>
      <pre>{technical}</pre>
    </details> : null}
  </section>
}

export default function SettingsFormActions({
  dirty, saving = false, idleLabel = '已保存', saveLabel = '保存', disabled = false, saveDisabled = false,
  error, conflict, placement = 'footer', onSave, onCancel, children
}: {
  dirty: boolean
  saving?: boolean
  saveLabel?: string
  idleLabel?: string
  disabled?: boolean
  saveDisabled?: boolean
  error?: string | null
  conflict?: boolean
  placement?: 'footer' | 'header'
  onSave: () => void
  onCancel: () => void
  children?: ReactNode
}): JSX.Element {
  const host = useContext(SettingsSaveDetailsContext)?.host
  const detailId = useId()
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const state = saving ? 'saving' : conflict ? 'conflict' : error ? 'error' : dirty ? 'dirty' : 'saved'
  const hasDetails = Boolean(error || conflict)
  const feedbackKey = JSON.stringify([error, conflict])
  useEffect(() => setExpandedKey(null), [error, conflict])
  const open = hasDetails && expandedKey === feedbackKey
  const label = saving ? '保存中…' : conflict ? '配置冲突' : error ? '保存失败' : dirty ? '待保存' : idleLabel
  const actionLabel = conflict ? '查看' : error ? '重试' : saveLabel
  const toggle = (): void => setExpandedKey(open ? null : feedbackKey)
  const details = open ? <SaveDetails key={feedbackKey} id={detailId} error={error} conflict={conflict} /> : null
  const indicator = state === 'saved' ? <Check {...UI_ICON_SM} className={styles.indicator} data-state={state} aria-hidden /> : <Circle size={8} fill="currentColor" className={styles.indicator} data-state={state} aria-hidden />
  return <div className={styles.root} data-placement={placement}>
    <div className={styles.actions}>
      {children}
      <div className={styles.toolbar} data-state={state} data-long-action={saveLabel.length > 2} role="group" aria-label="保存设置">
        <span className={styles.live} role={state === 'error' || state === 'conflict' ? 'alert' : 'status'}>{label}</span>
        {hasDetails ? <button type="button" className={styles.status} title={label} aria-expanded={open} aria-controls={open ? detailId : undefined} onClick={toggle}>
          {indicator}<span className={styles.statusText}>{label}</span><ChevronDown {...UI_ICON_SM} className={styles.chevron} data-open={open} aria-hidden />
        </button> : <span className={styles.status} title={label}>{indicator}<span className={styles.statusText}>{label}</span></span>}
        <span className={styles.divider} aria-hidden />
        <Button size="sm" variant="ghost" className={styles.undo} aria-label="取消更改" title={conflict ? '撤销更改并读取最新配置' : '撤销更改'} disabled={(!dirty && !conflict) || saving || disabled} onClick={onCancel}><Undo2 {...UI_ICON_SM} aria-hidden /></Button>
        <span className={styles.divider} aria-hidden />
        <Button size="sm" className={styles.save} variant={!conflict && (dirty || error) ? 'primary' : 'default'} busy={saving}
          disabled={conflict ? disabled || saving : !dirty || saving || disabled || saveDisabled}
          aria-label={saving ? '保存中' : actionLabel} onClick={conflict ? () => setExpandedKey(feedbackKey) : onSave}>{actionLabel}</Button>
      </div>
    </div>
    {placement === 'header' && host && details ? createPortal(details, host) : details}
  </div>
}
