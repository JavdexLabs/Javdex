import { useCallback, useEffect, useRef, useState } from 'react'
import { Monitor, RefreshCw } from 'lucide-react'
import type { TrustedDevice } from '@shared/protocol/writer'
import { api } from '../../api'
import { useDesktopSession } from '../../desktop/DesktopSessionContext'
import Button from '../Button'
import { UI_ICON, UI_ICON_MD } from '../iconDefaults'
import Modal from '../Modal'
import { SettingsCard } from './SettingsPrimitives'
import SettingsFeedback from './SettingsFeedback'
import styles from './TrustedDevicesPanel.module.css'

function formatAuthorizedAt(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).replaceAll('/', '-')
}

export default function TrustedDevicesPanel(): JSX.Element | null {
  const { session } = useDesktopSession()
  const [devices, setDevices] = useState<TrustedDevice[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<TrustedDevice | null>(null)
  const requestGeneration = useRef(0)
  const invalidateRequests = useCallback(() => { requestGeneration.current++ }, [])
  const available = session.mode === 'remote' && session.state === 'available'
  const loadDevices = useCallback(async (deviceId?: string): Promise<boolean> => {
    const generation = ++requestGeneration.current
    setBusy(true); setError(null)
    try {
      const result = await api.serverUpdate.control(deviceId ? { action: 'revokeDevice', deviceId } : { action: 'devices' })
      if (generation !== requestGeneration.current) return false
      setDevices(result.devices ?? [])
      setLoaded(true)
      return true
    } catch (reason) {
      if (generation !== requestGeneration.current) return false
      setError(reason instanceof Error ? reason.message : String(reason))
      throw reason
    } finally { if (generation === requestGeneration.current) setBusy(false) }
  }, [])
  useEffect(() => {
    setDevices([]); setLoaded(false); setRemoving(null); setError(null); setBusy(false)
    if (available && typeof api.serverUpdate?.control === 'function') void loadDevices().catch(() => {})
    return invalidateRequests
  }, [available, session.serverId, session.catalogId, session.generation, loadDevices, invalidateRequests])
  if (session.mode !== 'remote') return null
  const orderedDevices = [...devices].sort((left, right) => Number(right.current) - Number(left.current))
  return <SettingsCard as="section" aria-label="可信客户端" className={styles.card}
    title={<span className={styles.title}>可信客户端<span className={styles.count}
      aria-label={loaded ? `${devices.length} 个可信客户端` : '客户端数量未获取'}>{loaded ? `${devices.length} 个` : '—'}</span></span>}
    hint="这些客户端共享资料库，并拥有相同管理权限。"
    actions={<Button size="sm" variant="ghost" className={styles.refresh} busy={busy} disabled={busy || !available}
      onClick={() => void loadDevices().catch(() => {})}><RefreshCw {...UI_ICON_MD} />刷新</Button>}>
    {devices.length ? <ul className={styles.list} aria-label="可信客户端列表" aria-busy={busy}>
      {orderedDevices.map(device => <li key={device.id} className={styles.client} data-current={device.current || undefined}>
        <Monitor {...UI_ICON} size={20} className={styles.clientIcon} />
        <div className={styles.clientCopy}>
          <div className={styles.clientHeading}>
            <span className={styles.clientName}>{device.name}</span>
            {device.current ? <span className={styles.currentBadge}>当前客户端</span> : null}
          </div>
          <span className={styles.authorizedAt}>授权于 <time dateTime={device.createdAt}>{formatAuthorizedAt(device.createdAt)}</time></span>
        </div>
        {device.current ? <span className={styles.currentLabel}>当前使用</span> : <Button size="sm" variant="dangerGhost"
          className={styles.revoke} disabled={busy || !available} onClick={() => setRemoving(device)}>撤销授权</Button>}
      </li>)}
    </ul> : null}
    <footer className={styles.footer}>
      <p className={styles.addHint}>新增客户端：在服务端运行 <code>token</code> 获取一次性令牌。</p>
      <SettingsFeedback message={error ? '客户端管理失败，请查看详情。' : busy ? '正在读取客户端…' : !available ? '连接后可管理可信客户端。'
        : !devices.length ? '暂无可信客户端。' : '撤销后，该客户端将无法管理此资料库。'} detail={error} error={Boolean(error)} />
    </footer>
    {removing ? <Modal title={`撤销客户端授权：${removing.name}`} danger confirmText="撤销授权" onCancel={() => setRemoving(null)} onConfirm={async () => {
      if (await loadDevices(removing.id)) setRemoving(null)
    }}>该客户端将失去资料库管理、播放和服务端更新权限；重新连接需要使用新的令牌完成授权。</Modal> : null}
  </SettingsCard>
}
