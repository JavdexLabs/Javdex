import { useCallback, useEffect, useRef, useState } from 'react'
import type { ServerUpdateCommand, ServerUpdatePhase, ServerUpdateSnapshot } from '@shared/serverUpdateTypes'
import { sessionAllowsCatalogReads } from '@shared/desktop/session'
import { api } from '../../api'
import { useDesktopSession } from '../../desktop/DesktopSessionContext'
import { SettingsCard, SettingsDisclosure, SettingsStatusPill, SettingsValueRow } from './SettingsPrimitives'
import SettingsFeedback from './SettingsFeedback'
import Button from '../Button'
import TextArea from '../TextArea'
import Modal from '../Modal'
import { AppFormField } from '../FormPrimitives'
import styles from './ServerUpdatePanel.module.css'

const labels: Record<ServerUpdatePhase, string> = {
  preparing: '准备更新包', prepared: '更新包已就绪', stopping: '停止服务', backup: '备份资料', installing: '安装版本', verifying: '验证服务', activating: '恢复访问', complete: '更新完成', restoring: '恢复原版本', restored: '已恢复原版本', failed: '准备失败', recoveryRequired: '需要人工恢复'
}
const running = new Set<ServerUpdatePhase>(['preparing', 'stopping', 'backup', 'installing', 'verifying', 'activating', 'restoring'])

export default function ServerUpdatePanel(): JSX.Element | null {
  const { session, reconnect } = useDesktopSession()
  const [snapshot, setSnapshot] = useState<ServerUpdateSnapshot | null>(null)
  const [pairing, setPairing] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyAction, setBusyAction] = useState<ServerUpdateCommand['action'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const requestGeneration = useRef(0)
  const reconnected = useRef<string | null>(null)
  const reconnecting = useRef(false)
  const mounted = useRef(true)
  const commandBusy = useRef(false)
  const commandAction = useRef<ServerUpdateCommand['action'] | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const accepts = useCallback((result: ServerUpdateSnapshot): boolean =>
    !result.paired || ((!session.serverId || result.serverId === session.serverId) && (!session.catalogId || result.catalogId === session.catalogId)), [session.serverId, session.catalogId])
  const command = async (input: ServerUpdateCommand): Promise<void> => {
    if (commandBusy.current) return
    commandBusy.current = true
    commandAction.current = input.action
    const generation = ++requestGeneration.current
    setBusy(true)
    setBusyAction(input.action)
    try {
      const result = await api.serverUpdate.control(input)
      if (!mounted.current || generation !== requestGeneration.current || !accepts(result)) return
      setSnapshot(result)
      setError(null)
      if (input.action === 'pair') setPairing('')
    } catch (reason) { if (mounted.current && generation === requestGeneration.current) setError((reason as Error).message) }
    finally { commandBusy.current = false; commandAction.current = null; if (mounted.current && generation === requestGeneration.current) { setBusy(false); setBusyAction(null) } }
  }
  useEffect(() => {
    if (session.mode !== 'remote' || !api.serverUpdate) return
    let cancelled = false
    let polling = false
    const refresh = async (): Promise<void> => {
      if (polling || (commandBusy.current && commandAction.current !== 'import')) return
      polling = true
      const generation = requestGeneration.current
      try {
        const result = await api.serverUpdate.control({ action: 'status' })
        if (cancelled || generation !== requestGeneration.current) return
        if (!accepts(result)) { setPollError('更新助手不属于当前资料库，请重新配对'); return }
        setSnapshot(result)
        setPollError(null)
        if (result.job && ['complete', 'restored'].includes(result.job.phase) && reconnected.current !== result.job.id && result.currentVersion === session.desktopAppVersion) {
          if (session.appVersion === result.currentVersion && sessionAllowsCatalogReads(session)) reconnected.current = result.job.id
          else if (!reconnecting.current) {
            reconnecting.current = true
            try { await reconnect() } finally { reconnecting.current = false }
          }
        }
      } catch (reason) { if (!cancelled && generation === requestGeneration.current) setPollError((reason as Error).message) }
      finally { polling = false }
    }
    void refresh()
    const interval = setInterval(() => { void refresh() }, 2000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [session, reconnect, accepts])
  if (session.mode !== 'remote' || !api.serverUpdate) return null
  const job = snapshot?.job
  const installing = job && running.has(job.phase)
  const transfer = job?.phase === 'preparing' && job.receivedBytes > 0
  const message = error ?? (job ? `${labels[job.phase]}${transfer ? `：${Math.floor(job.receivedBytes / 1024 ** 2)} / ${Math.ceil(job.totalBytes / 1024 ** 2)} MiB` : ''}` : snapshot?.paired ? '更新由你手动发起，安装期间会中断访问和播放。' : '使用支持托管更新的官方容器，首次只需配对，无需额外安装助手。')
  return <SettingsCard as="section" aria-label="服务端更新" title="服务端更新" actions={<SettingsStatusPill status={installing ? 'running' : snapshot?.paired ? 'success' : 'muted'}>{installing ? '更新中' : snapshot?.paired ? '已配对' : '未配对'}</SettingsStatusPill>}>
    <div className={styles.content}>
      {snapshot?.paired ? <>
        <div className={styles.versions}>
          <SettingsValueRow label="服务端版本" value={snapshot.currentVersion ?? session.appVersion ?? '—'} />
          <SettingsValueRow label="可用版本" value={snapshot.targetVersion ?? '—'} />
          {snapshot.runtime ? <SettingsValueRow label="运行环境" value={snapshot.runtime} /> : null}
        </div>
        <div className={styles.actions}>
          <Button size="sm" busy={busy && busyAction === 'check'} disabled={busy || Boolean(installing)} onClick={() => { void command({ action: 'check' }) }}>检查更新</Button>
          <Button size="sm" busy={busy && busyAction === 'prepare'} disabled={busy || Boolean(installing) || !snapshot.targetVersion} onClick={() => { void command({ action: 'prepare' }) }}>准备在线更新</Button>
          <Button size="sm" busy={busy && busyAction === 'import'} disabled={busy || Boolean(installing && job?.phase !== 'preparing')} onClick={() => { void command({ action: 'import' }) }}>上传离线包</Button>
          <Button size="sm" variant="primary" disabled={busy || job?.phase !== 'prepared'} onClick={() => setConfirm(true)}>安装更新</Button>
        </div>
        {snapshot.currentVersion && session.desktopAppVersion && snapshot.currentVersion !== session.desktopAppVersion ? <p className={styles.note}>桌面与服务端版本不同，请同步升级桌面后重新连接。</p> : null}
        <SettingsDisclosure title="更新授权">
          <p>解除本机配对仅移除这台电脑保存的授权；撤销所有设备需由部署管理员更换容器程序卷中的更新凭据。</p>
          <Button size="sm" busy={busy && busyAction === 'forget'} disabled={busy || Boolean(installing)} onClick={() => { void command({ action: 'forget' }) }}>解除本机配对</Button>
        </SettingsDisclosure>
      </> : <>
        <AppFormField label="容器生成的配对信息">
          <TextArea density="workspace" rows={3} value={pairing} autoComplete="off" spellCheck={false} onChange={event => setPairing(event.target.value)} />
        </AppFormField>
        <div className={styles.actions}><Button size="sm" busy={busy} disabled={!pairing.trim()} onClick={() => { void command({ action: 'pair', pairing }) }}>配对更新管理器</Button></div>
      </>}
      <SettingsFeedback message={busy ? `正在更新状态；上次结果：${pollError ?? message}` : pollError ?? message} error={Boolean(error || pollError || job?.phase === 'recoveryRequired')} detail={error ?? pollError ?? job?.message} />
    </div>
    {confirm && job ? <Modal title={`更新服务端至 ${job.version}`} confirmText="停服并更新" onCancel={() => setConfirm(false)} onConfirm={async () => {
      const result = await api.serverUpdate.control({ action: 'install', jobId: job.id })
      setSnapshot(result)
      setConfirm(false)
    }}><p>更新会中断服务端访问与播放，完成完整备份后安装新版本。验证失败时恢复原版本和升级前资料；请同时使用相同版本的桌面客户端。</p></Modal> : null}
  </SettingsCard>
}
