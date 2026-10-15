import { useCallback, useEffect, useRef, useState } from 'react'
import type { TrustedDevice } from '@shared/protocol/writer'
import { api } from '../../api'
import { useDesktopSession } from '../../desktop/DesktopSessionContext'
import Button from '../Button'
import Modal from '../Modal'
import { SettingsCard, SettingsValueRow } from './SettingsPrimitives'
import SettingsFeedback from './SettingsFeedback'

export default function TrustedDevicesPanel(): JSX.Element | null {
  const { session } = useDesktopSession()
  const [devices, setDevices] = useState<TrustedDevice[]>([])
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
      return true
    } catch (reason) {
      if (generation !== requestGeneration.current) return false
      setError(reason instanceof Error ? reason.message : String(reason))
      throw reason
    } finally { if (generation === requestGeneration.current) setBusy(false) }
  }, [])
  useEffect(() => {
    setDevices([]); setRemoving(null); setError(null); setBusy(false)
    if (available && typeof api.serverUpdate?.control === 'function') void loadDevices().catch(() => {})
    return invalidateRequests
  }, [available, session.serverId, session.catalogId, session.generation, loadDevices, invalidateRequests])
  if (session.mode !== 'remote') return null
  return <SettingsCard title="可信设备" hint="这些电脑共享资料库并拥有相同管理权限。新增电脑时在服务端重新运行 pair。"
    actions={<Button size="sm" busy={busy} disabled={busy || !available} onClick={() => void loadDevices().catch(() => {})}>刷新</Button>}>
    {devices.map(device => <SettingsValueRow key={device.id} label={`${device.name}${device.current ? ' · 此电脑' : ''}`}
      value={`配对于 ${new Date(device.createdAt).toLocaleString()}`}
      actions={!device.current ? <Button size="sm" variant="danger" disabled={busy || !available} onClick={() => setRemoving(device)}>撤销</Button> : undefined} />)}
    <SettingsFeedback message={error ? '设备管理失败，请查看详情。' : busy ? '正在读取设备…' : !available ? '连接后可管理可信设备。' : `${devices.length} 台可信设备`} detail={error} error={Boolean(error)} />
    {removing ? <Modal title={`撤销 ${removing.name}`} danger confirmText="撤销设备" onCancel={() => setRemoving(null)} onConfirm={async () => {
      if (await loadDevices(removing.id)) setRemoving(null)
    }}>该电脑将失去资料库管理、播放和服务端更新权限；重新连接需要再次配对。</Modal> : null}
  </SettingsCard>
}
