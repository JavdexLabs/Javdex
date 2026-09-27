import SettingsActionLabel from './SettingsActionLabel'
import { useId, useState } from 'react'
import { useDesktopSession } from '../../desktop/DesktopSessionContext'
import Button from '../Button'
import SettingsFeedback from './SettingsFeedback'
import styles from './CatalogConnectionPanel.module.css'

/** Writer authorization is handled only in connection settings. */
export default function WriterAuthorizationForm(): JSX.Element {
  const { session, claimWriter } = useDesktopSession()
  const inputId = useId()
  const hintId = useId()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const initial = session.state === 'claimRequired'
  return <form className={styles.claimForm} aria-busy={busy} onSubmit={event => {
    event.preventDefault()
    if (busy || token.trim().length < 32) return
    setBusy(true); setError(null)
    void claimWriter({ kind: session.writerEpoch && session.writerEpoch > 0 ? 'deployRecover' : 'initialBind', oneTimeToken: token.trim() })
      .then(result => {
        if (result.status === 'consumed' && result.bound) setToken('')
        else setError('授权尚未完成，请等待服务端维护结束后重试。')
      })
      .catch(reason => setError((reason as Error).message))
      .finally(() => setBusy(false))
  }}>
    <label className={styles.claimLabel} htmlFor={inputId}>{initial ? '首次授权' : '恢复写入授权'}</label>
    <p id={hintId} className={styles.claimHint}>请部署者在服务端运行 {initial ? 'bind' : 'recover'} 命令，取得一次性令牌。网页账号密码不能代替此令牌。</p>
    <div className={styles.claimInputRow}>
      <input id={inputId} className={`text-input ${styles.claimInput}`} value={token} disabled={busy}
        autoComplete="off" spellCheck={false} placeholder="粘贴一次性令牌" aria-describedby={hintId}
        onChange={event => setToken(event.target.value)} />
      <Button className={styles.claimButton} type="submit" disabled={busy || token.trim().length < 32}><SettingsActionLabel reserve="领取写入凭据">{busy ? '正在授权…' : '领取写入凭据'}</SettingsActionLabel></Button>
    </div>
    <SettingsFeedback error={Boolean(error)} detail={error} message={busy ? '正在领取写入凭据…' : error || '提交令牌后，此设备将获得资料库写入权限。'} />
  </form>
}
