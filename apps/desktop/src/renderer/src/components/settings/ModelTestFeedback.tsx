import { useState } from 'react'
import { CheckCircle2, ChevronRight, Clock3, Info, XCircle } from 'lucide-react'
import styles from './ModelTestFeedback.module.css'

/** Model-local test status and raw response, without a second dialog. */
export default function ModelTestFeedback({ busy, dirty, result }: {
  busy: boolean
  dirty: boolean
  result?: { ok: boolean; detail: string }
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const state = dirty ? 'dirty' : busy ? 'busy' : result ? result.ok ? 'success' : 'error' : 'idle'
  const Icon = state === 'success' ? CheckCircle2 : state === 'error' ? XCircle : state === 'busy' ? Clock3 : Info
  const title = state === 'dirty' ? '连接未保存' : state === 'busy' ? '正在测试'
    : state === 'success' ? '测试通过' : state === 'error' ? '测试失败' : '尚未测试'
  const hint = state === 'dirty' ? '保存连接后再测试' : state === 'busy' ? '等待生成响应'
    : state === 'success' ? '已收到生成响应' : state === 'error' ? '请检查错误明细' : '使用已保存的连接'
  const detailLabel = result?.ok ? '原始响应' : '错误明细'
  const content = <>
    <Icon size={14} className={styles.statusIcon} aria-hidden="true" />
    <span className={styles.statusCopy}>
      <strong className={styles.statusTitle}>{title}</strong>
      <span className={styles.hint}>{hint}</span>
    </span>
    {result?.detail ? <span className={styles.disclosureHint}>
      {detailLabel}<ChevronRight size={14} className={styles.chevron} data-open={open} aria-hidden="true" />
    </span> : null}
  </>

  return <div className={styles.root} data-state={state} aria-busy={busy || undefined}>
    {/* A separate live region avoids announcing the full raw output on updates. */}
    <span className={styles.announcement} role={state === 'error' ? 'alert' : 'status'}>
      {title} · {hint}
    </span>
    {result?.detail ? <details open={open}
      onToggle={event => {
        const nextOpen = event.currentTarget.open
        setOpen(nextOpen)
      }}>
      <summary className={styles.statusRow} data-interactive aria-label={`${title}，${open ? '收起' : '展开'}${detailLabel}`}>
        {content}
      </summary>
      <div className={styles.response}>
        <div className={styles.responseHeading}>
          <span>{busy || dirty ? '上次测试结果' : detailLabel}</span>
          <span className={styles.responseHint}>可选中复制</span>
        </div>
        <pre className={styles.responseText} tabIndex={0} aria-label={detailLabel}>{result.detail}</pre>
      </div>
    </details> : <div className={styles.statusRow}>{content}</div>}
  </div>
}
