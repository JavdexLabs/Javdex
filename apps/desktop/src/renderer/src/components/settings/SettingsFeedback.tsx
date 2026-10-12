import { useState } from 'react'
import Button from '../Button'
import Modal from '../Modal'
import styles from './SettingsFeedback.module.css'

/** One compact line for async feedback; full text remains keyboard accessible. */
export default function SettingsFeedback({ message, error = false, detail, detailPresentation = 'modal' }: {
  message: string
  error?: boolean
  detail?: string | null
  detailPresentation?: 'modal' | 'inline'
}): JSX.Element {
  const [open, setOpen] = useState(false)
  if (detailPresentation === 'inline') return <div>
    <div className={styles.root}>
      <span className={styles.text} data-error={error} role={error ? 'alert' : 'status'} title={message}>{message}</span>
      <Button size="sm" className={!detail ? styles.hidden : undefined} disabled={!detail}
        tabIndex={detail ? 0 : -1} aria-hidden={!detail} aria-expanded={open}
        onClick={() => setOpen(value => !value)}>{open ? '收起详情' : '展开详情'}</Button>
    </div>
    {open && detail ? <p className={`${styles.detail} ${styles.inlineDetail}`}>{detail}</p> : null}
  </div>
  return <div className={styles.root}>
    <span className={styles.text} data-error={error} role={error ? 'alert' : 'status'} title={message}>{message}</span>
    <Button size="sm" className={!detail ? styles.hidden : undefined} disabled={!detail}
      tabIndex={detail ? 0 : -1} aria-hidden={!detail} onClick={() => setOpen(true)}>查看详情</Button>
    {open && detail ? <Modal title="操作详情" onCancel={() => setOpen(false)}
      actions={<Button onClick={() => setOpen(false)}>关闭</Button>}>
      <p className={styles.detail}>{detail}</p>
    </Modal> : null}
  </div>
}
