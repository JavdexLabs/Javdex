import TextArea from '../TextArea'
import { useId, useRef, useState } from 'react'
import Button from '../Button'
import SettingsFeedback from './SettingsFeedback'
import { SettingsStatusPill } from './SettingsPrimitives'
import styles from './CatalogConnectionPanel.module.css'

/** Writer authorization is handled only in connection settings. */
export default function WriterAuthorizationForm({ targetAddress, disabled = false, onBusyChange, onAuthorize }: {
  targetAddress: string
  disabled?: boolean
  onBusyChange: (busy: boolean) => void
  onAuthorize?: (token: string) => Promise<boolean>
}): JSX.Element {
  const inputId = useId()
  const hintId = useId()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const authorize = async (): Promise<void> => {
    if (disabled || submitting.current || !/^[a-f0-9]{64}$/.test(token.trim()) || !targetAddress.trim()) return
    submitting.current = true
    setBusy(true); onBusyChange(true); setError(null)
    try {
      const value = token.trim()
      if (!onAuthorize) throw new Error('当前客户端不支持服务器授权。')
      if (await onAuthorize(value)) setToken('')
    } catch (reason) { setError((reason as Error).message) }
    finally { submitting.current = false; setBusy(false); onBusyChange(false) }
  }
  return <form className={`${styles.connectionRow} ${styles.authorizationRow}`} aria-label="写入授权" aria-busy={busy} onSubmit={event => {
    event.preventDefault()
    void authorize()
  }}>
    <div className={styles.authorizationLabel}>
      <label className={styles.connectionLabel} htmlFor={inputId}>写入授权</label>
      <SettingsStatusPill status="warning">待授权</SettingsStatusPill>
    </div>
    <div className={styles.connectionControls}>
      <TextArea id={inputId} aria-label="写入授权信息" density="workspace" rows={2} value={token} disabled={busy || disabled}
        autoComplete="off" spellCheck={false} placeholder="粘贴一次性令牌…" aria-describedby={hintId}
        onChange={event => { setToken(event.target.value); setError(null) }} />
      <p id={hintId} className={styles.connectionNote}>在服务端运行 token 命令，粘贴生成的一次性令牌；有效期 10 分钟。</p>
      <div className={styles.authorizationActions}>
        <SettingsFeedback error={Boolean(error)} detail={error} message={busy ? '正在完成写入授权…' : error ? '写入授权失败，请查看详情。' : '授权成功后，此电脑可管理服务端资料。'} />
        <Button variant="primary" type="submit" busy={busy} disabled={disabled || busy || !/^[a-f0-9]{64}$/.test(token.trim()) || !targetAddress.trim()}>完成授权</Button>
      </div>
    </div>
  </form>
}
