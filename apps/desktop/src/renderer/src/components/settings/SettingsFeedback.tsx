import { useState } from 'react'
import Button from '../Button'
import Modal from '../Modal'
import styles from './SettingsFeedback.module.css'

/** One compact line for async feedback; full text remains keyboard accessible. */
export default function SettingsFeedback({ message, error = false, detail }: {
  message: string
  error?: boolean
  detail?: string | null
}): JSX.Element {
  const [open, setOpen] = useState(false)
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
