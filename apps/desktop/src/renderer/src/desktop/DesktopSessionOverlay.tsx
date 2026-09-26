import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { sessionAllowsCatalogReads, type DesktopSession } from '@shared/desktop/session'
import Button from '../components/Button'
import EmptyState from '../components/EmptyState'
import { settingsPath } from '../settings/settingsRoutes'
import { useDesktopSession } from './DesktopSessionContext'
import styles from './DesktopSessionOverlay.module.css'

function titleFor(session: DesktopSession): string {
  switch (session.state) {
    case 'versionMismatch':
      return '桌面与服务器版本不一致'
    case 'recoveryRequired':
      return '需要重新领取写入凭据'
    case 'claimRequired':
      return '服务已连接，等待首次授权'
    case 'authInvalid':
      return '写入授权已失效'
    case 'modePrepRequired':
      return '远程模式尚未准备完成'
    case 'disconnected':
      return session.mode === 'remote' ? '无法连接远程资料库' : '资料库不可用'
    case 'starting':
      return '正在连接资料库'
    default:
      return '资料库不可用'
  }
}

function descriptionFor(session: DesktopSession): string {
  if (session.state === 'authInvalid') return '远程请求已暂停。请前往连接设置恢复授权，完成后核对资料并手动重新提交未完成的操作。'
  if (session.message) return session.message
  if (session.state === 'starting') return '正在读取此电脑的连接状态。'
  if (session.state === 'modePrepRequired') {
    return '请先回到本地模式完成工作记录复制，不要在远程模式打开原资料库。'
  }
  if (session.state === 'claimRequired') return '在服务端生成一次性令牌，然后在连接设置中领取写入凭据。'
  return '可以打开设置修改连接方式，或切回本地模式后重启。'
}

export default function DesktopSessionOverlay(): JSX.Element | null {
  const { session, reconnect } = useDesktopSession()
  const location = useLocation()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onSettings = location.pathname.startsWith('/settings')
  const blocking = !sessionAllowsCatalogReads(session) && session.state !== 'starting'

  if (session.state === 'frozen') {
    return (
      <div className={styles.banner} role="status">
        资料库已冻结，当前只能读取，不能保存修改。
      </div>
    )
  }

  if (!blocking || onSettings) return null

  return (
    <div className={styles.overlay} role="alert">
      <EmptyState variant="fill" title={titleFor(session)} description={descriptionFor(session)}>
        <div className={styles.actions}>
          <Button onClick={() => navigate(settingsPath('storage', 'mode'))}>打开连接设置</Button>
          {session.state === 'disconnected' ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                setError(null)
                void reconnect()
                  .catch((reason) => setError((reason as Error).message))
                  .finally(() => setBusy(false))
              }}
            >
              重新连接
            </Button>
          ) : null}
        </div>
        {error ? <p className={styles.error}>{error}</p> : null}
      </EmptyState>
    </div>
  )
}
