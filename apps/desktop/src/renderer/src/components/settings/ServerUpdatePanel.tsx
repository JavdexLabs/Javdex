import { useCallback, useEffect, useRef, useState } from 'react'
import lt from 'semver/functions/lt'
import valid from 'semver/functions/valid'
import { ArrowRight, CheckCircle2, ChevronDown, Circle, CloudDownload, Info, LoaderCircle, Upload } from 'lucide-react'
import type { ServerUpdateCommand, ServerUpdatePhase, ServerUpdateSnapshot } from '@shared/serverUpdateTypes'
import { sessionAllowsCatalogReads } from '@shared/desktop/session'
import { api } from '../../api'
import { useDesktopSession } from '../../desktop/DesktopSessionContext'
import { SettingsCard } from './SettingsPrimitives'
import SettingsFeedback from './SettingsFeedback'
import Button from '../Button'
import Modal from '../Modal'
import { UI_ICON, UI_ICON_SM } from '../iconDefaults'
import styles from './ServerUpdatePanel.module.css'

const labels: Record<ServerUpdatePhase, string> = {
  preparing: '正在准备升级包', prepared: '升级包已就绪，等待确认安装', stopping: '正在停止服务', installing: '正在安装版本', verifying: '正在验证服务', activating: '正在恢复访问', complete: '升级完成，正在重新连接', failed: '升级未完成，原服务继续运行', recoveryRequired: '需要人工恢复'
}
const running = new Set<ServerUpdatePhase>(['preparing', 'stopping', 'installing', 'verifying', 'activating'])

export default function ServerUpdatePanel(): JSX.Element | null {
  const { session, reconnect } = useDesktopSession()
  const [snapshot, setSnapshot] = useState<ServerUpdateSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [busyAction, setBusyAction] = useState<ServerUpdateCommand['action'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [technical, setTechnical] = useState(false)
  const requestGeneration = useRef(0)
  const reconnected = useRef<string | null>(null)
  const reconnecting = useRef(false)
  const mounted = useRef(true)
  const commandBusy = useRef(false)
  const commandAction = useRef<ServerUpdateCommand['action'] | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const accepts = useCallback((result: ServerUpdateSnapshot): boolean =>
    !result.paired || ((!session.serverId || result.serverId === session.serverId) && (!session.catalogId || result.catalogId === session.catalogId)), [session.serverId, session.catalogId])
  const command = async (input: ServerUpdateCommand, online = false): Promise<void> => {
    if (commandBusy.current) throw new Error('已有升级请求正在处理')
    commandBusy.current = true
    commandAction.current = input.action
    const generation = ++requestGeneration.current
    setBusy(true)
    setBusyAction(input.action)
    try {
      let result = await api.serverUpdate.control(input)
      if (!mounted.current || generation !== requestGeneration.current) return
      if (!accepts(result)) throw new Error('升级目标不属于当前资料库，请核对连接')
      if (online) {
        const targetVersion = session.desktopAppVersion
        if (!targetVersion || result.targetVersion !== targetVersion) throw new Error('未找到与此客户端版本一致的升级包')
        result = await api.serverUpdate.control({ action: 'prepare', targetVersion })
        if (!mounted.current || generation !== requestGeneration.current) return
        if (!accepts(result)) throw new Error('升级目标不属于当前资料库，请核对连接')
      }
      setSnapshot(result)
      setError(null)
    } catch (reason) { if (mounted.current && generation === requestGeneration.current) setError((reason as Error).message); throw reason }
    finally { commandBusy.current = false; commandAction.current = null; if (mounted.current && generation === requestGeneration.current) { setBusy(false); setBusyAction(null) } }
  }
  useEffect(() => {
    requestGeneration.current++
    setSnapshot(null); setError(null); setPollError(null); setConfirm(false); setBusy(false); setBusyAction(null)
    reconnected.current = null
  }, [session.remoteBaseUrl, session.serverId, session.catalogId])
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
        if (!accepts(result)) { setPollError('升级目标不属于当前资料库，请核对连接'); return }
        setSnapshot(result)
        setPollError(null)
        if (result.job && result.job.phase === 'complete' && reconnected.current !== result.job.id && result.currentVersion === session.desktopAppVersion) {
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
  const serverVersion = snapshot?.currentVersion ?? session.appVersion
  const clientVersion = session.desktopAppVersion
  const older = Boolean(serverVersion && clientVersion && valid(serverVersion) && valid(clientVersion) && lt(serverVersion, clientVersion))
  const activeJob = Boolean(job && !['complete', 'failed'].includes(job.phase))
  const reconnectPending = job?.phase === 'complete' && !sessionAllowsCatalogReads(session)
  if (!older && !activeJob && !reconnectPending) return null
  const installing = Boolean(job && running.has(job.phase))
  const locked = installing || job?.phase === 'recoveryRequired' || Boolean(reconnectPending)
  const supported = snapshot?.paired
  const ready = job?.phase === 'prepared' && job.version === clientVersion
  const transfer = job?.phase === 'preparing' && job.receivedBytes > 0
  const message = job && (activeJob || reconnectPending || job.phase === 'failed') ? labels[job.phase] : '服务端版本较旧，升级后可恢复使用。'
  const stages: Array<{ label: string; phases: ServerUpdatePhase[] }> = [
    { label: '准备升级包', phases: ['preparing', 'prepared'] }, { label: '停止服务', phases: ['stopping'] },
    { label: '安装版本', phases: ['installing'] }, { label: '验证服务', phases: ['verifying'] },
    { label: '重新连接', phases: ['activating', 'complete'] }
  ]
  const stage = stages.findIndex(item => job && item.phases.includes(job.phase))
  const unavailable = !snapshot ? '正在读取升级状态。' : !snapshot.paired ? '请先在资料库连接中连接此服务端。' : null
  return <SettingsCard as="section" aria-label="服务端升级" title="服务端升级" className={styles.card} actions={
    <Button variant="ghost" size="sm" className={styles.technicalButton} aria-expanded={technical} onClick={() => setTechnical(value => !value)}>技术信息<ChevronDown {...UI_ICON_SM} /></Button>
  }>
    <div className={styles.content}>
      <p className={styles.status} data-active={locked || busy || ready || undefined} role="status">
        {locked || busy ? <LoaderCircle className={styles.spinner} {...UI_ICON} /> : ready ? <CheckCircle2 {...UI_ICON} /> : <Info {...UI_ICON} />}
        {busy ? busyAction === 'import' ? '正在上传并校验离线包' : busyAction === 'install' ? '正在提交升级请求' : '正在获取匹配版本的升级包' : message}
      </p>
      <div className={styles.versions}>
        <div><span className={styles.label}>服务端</span><strong className={styles.version}>{serverVersion ?? '—'}</strong></div>
        <ArrowRight className={styles.arrow} {...UI_ICON} />
        <div><span className={styles.label}>此客户端</span><strong className={styles.version}>{clientVersion ?? '—'}</strong></div>
      </div>
      {locked ? <div className={styles.progress}>
        {stage >= 0 && <ol className={styles.stages} aria-label="升级进度">{stages.map((item, index) => <li key={item.label} data-state={index < stage ? 'done' : index === stage ? 'current' : 'pending'} aria-current={index === stage ? 'step' : undefined}>
          {index < stage ? <CheckCircle2 {...UI_ICON_SM} /> : index === stage ? <LoaderCircle {...UI_ICON_SM} className={styles.spinner} /> : <Circle {...UI_ICON_SM} />}{item.label}
        </li>)}</ol>}
        <p className={styles.note}>{job?.phase === 'recoveryRequired' ? job.message : transfer ? `已传输 ${Math.floor(job!.receivedBytes / 1024 ** 2)} / ${Math.ceil(job!.totalBytes / 1024 ** 2)} MiB` : reconnectPending ? '服务端升级完成，正在重新连接资料库。' : '升级期间暂时无法访问与播放，请勿关闭服务端。'}</p>
      </div> : ready ? <div className={styles.ready}>
        <div><strong>升级包已就绪</strong><p className={styles.note}>版本与此客户端一致，签名及完整性校验通过。</p></div>
        <Button size="sm" variant="primary" disabled={busy || !supported} onClick={() => setConfirm(true)}>确认升级</Button>
        <Button size="sm" variant="ghost" disabled={busy || !supported} onClick={() => { void command({ action: 'import', targetVersion: clientVersion! }).catch(() => {}) }}>重新上传</Button>
      </div> : <div className={styles.entries}>
        <div className={styles.entry}><Button variant="primary" className={styles.entryButton} busy={busy && busyAction === 'check'} disabled={busy || !supported || !clientVersion} onClick={() => { void command({ action: 'check', targetVersion: clientVersion! }, true).catch(() => {}) }}><CloudDownload {...UI_ICON} />在线升级</Button><p className={styles.note}>从网络获取与此客户端匹配的升级包。</p></div>
        <div className={styles.entry}><Button className={styles.entryButton} busy={busy && busyAction === 'import'} disabled={busy || !supported || !clientVersion} onClick={() => { void command({ action: 'import', targetVersion: clientVersion! }).catch(() => {}) }}><Upload {...UI_ICON} />上传离线包升级</Button><p className={styles.note}>上传匹配版本的官方 .javdex-update 文件。</p></div>
      </div>}
      <div className={styles.footer}><Info {...UI_ICON_SM} /><p className={styles.note}>如有重要资料，建议升级前使用与当前服务端版本一致的客户端备份资料库。</p></div>
      {unavailable || error || pollError || job?.message ? <SettingsFeedback message={error ?? pollError ?? unavailable ?? job?.message ?? '正在读取升级状态'} error={Boolean(error || pollError || job?.phase === 'recoveryRequired')} detail={error ?? pollError ?? job?.message} detailPresentation="inline" /> : null}
      {technical && <dl className={styles.technical}><dt>架构</dt><dd>{snapshot?.platform ?? '—'}</dd><dt>运行环境</dt><dd>{snapshot?.runtime ?? '—'}</dd></dl>}
    </div>
    {confirm && ready && job ? <Modal title={`升级服务端至 ${clientVersion}`} confirmText="停服并升级" onCancel={() => setConfirm(false)} onConfirm={async () => {
      await command({ action: 'install', jobId: job.id, targetVersion: clientVersion! })
      setConfirm(false)
    }}><p>升级会暂停服务端访问与播放，完成后重新连接资料库。</p><p>如有重要资料，建议升级前使用与当前服务端版本一致的客户端备份资料库。</p><p>安装开始后失败或中断需要人工恢复。</p></Modal> : null}
  </SettingsCard>
}
