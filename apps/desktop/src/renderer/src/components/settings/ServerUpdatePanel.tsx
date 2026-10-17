import { useCallback, useEffect, useId, useRef, useState } from 'react'
import lt from 'semver/functions/lt'
import valid from 'semver/functions/valid'
import { ArrowRight, BookOpen, CheckCircle2, ChevronDown, Circle, CloudDownload, Info, LoaderCircle, RefreshCw, Upload } from 'lucide-react'
import type { ServerUpdateCommand, ServerUpdatePhase, ServerUpdateSnapshot } from '@shared/serverUpdateTypes'
import { SERVER_ENVIRONMENT_VERSION, SERVER_IMAGE_UPGRADE_MESSAGE, type ServerEnvironmentSnapshot } from '@shared/serverEnvironment'
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
  if (session.mode !== 'remote' || !api.serverUpdate) return null
  const identity = JSON.stringify([session.remoteBaseUrl, session.serverId, session.catalogId, session.generation, session.desktopAppVersion])
  return <ServerUpdateSession key={identity} session={session} reconnect={reconnect} />
}

function ServerUpdateSession({ session, reconnect }: Pick<ReturnType<typeof useDesktopSession>, 'session' | 'reconnect'>): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<ServerUpdateSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [busyAction, setBusyAction] = useState<ServerUpdateCommand['action'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [environment, setEnvironment] = useState<ServerEnvironmentSnapshot | null>(null)
  const [environmentBusy, setEnvironmentBusy] = useState(true)
  const [confirm, setConfirm] = useState(false)
  const [guide, setGuide] = useState(false)
  const [technical, setTechnical] = useState(false)
  const environmentDescriptionId = useId()
  const environmentGeneration = useRef(0)
  const requestGeneration = useRef(0)
  const reconnected = useRef<string | null>(null)
  const reconnecting = useRef(false)
  const mounted = useRef(true)
  const commandBusy = useRef(false)
  const commandAction = useRef<ServerUpdateCommand['action'] | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const accepts = useCallback((result: ServerUpdateSnapshot): boolean =>
    !result.paired || ((!session.serverId || result.serverId === session.serverId) && (!session.catalogId || result.catalogId === session.catalogId)), [session.serverId, session.catalogId])
  const checkEnvironment = useCallback(async (): Promise<void> => {
    const generation = ++environmentGeneration.current
    setEnvironmentBusy(true)
    try {
      const result = await api.serverUpdate.control({ action: 'environment' })
      if (!mounted.current || generation !== environmentGeneration.current) return
      if (!accepts(result)) throw new Error('升级目标不属于当前资料库，请核对连接')
      if (!result.environment) throw new Error('未能读取运行环境信息，请检查连接后重新检测')
      setEnvironment(result.environment)
    } catch (reason) {
      if (mounted.current && generation === environmentGeneration.current) setEnvironment({
        state: 'unavailable', currentVersion: null, requiredVersion: SERVER_ENVIRONMENT_VERSION,
        runtimeId: null, platform: null, message: reason instanceof Error ? reason.message : String(reason)
      })
    } finally {
      if (mounted.current && generation === environmentGeneration.current) setEnvironmentBusy(false)
    }
  }, [accepts])
  useEffect(() => {
    if (session.mode !== 'remote' || !api.serverUpdate) return
    void checkEnvironment()
  }, [session.mode, session.remoteBaseUrl, checkEnvironment])
  const command = async (input: ServerUpdateCommand, online = false): Promise<void> => {
    if (environmentBusy || environment?.state !== 'compatible' || environment.currentVersion !== environment.requiredVersion) throw new Error('请先确认服务端运行环境兼容')
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
  const reconnectPending = job?.phase === 'complete' && job.version === clientVersion && serverVersion === clientVersion && !sessionAllowsCatalogReads(session)
  const environmentCompatible = environment?.state === 'compatible' && environment.currentVersion === environment.requiredVersion
  if (!older && !activeJob && !reconnectPending && environmentCompatible && !environmentBusy) return null
  const resumableUpload = job?.phase === 'preparing' && job.resumableUpload === true && !busy
  const installing = Boolean(job && running.has(job.phase) && !resumableUpload)
  const locked = installing || job?.phase === 'recoveryRequired' || Boolean(reconnectPending)
  const supported = snapshot?.paired
  const ready = job?.phase === 'prepared' && job.version === clientVersion
  const transfer = job?.phase === 'preparing' && job.receivedBytes > 0
  const executing = installing || Boolean(reconnectPending) || busyAction === 'install'
  const imageRequired = environment?.state === 'imageRequired' && !environmentBusy && !locked
  const environmentUnavailable = !environment || environment.state === 'unavailable' || (environment.state === 'compatible' && !environmentCompatible)
  const message = job && locked ? labels[job.phase]
    : environmentBusy ? '正在检测服务端运行环境'
      : environment?.state === 'imageRequired' ? SERVER_IMAGE_UPGRADE_MESSAGE
        : environment?.state === 'clientRequired' ? '服务端运行环境较新，请升级此客户端'
          : !environmentCompatible ? '无法确认服务端运行环境'
            : job && (ready || job.phase === 'failed') ? labels[job.phase] : '服务端版本较旧，升级后可恢复使用。'
  const stages: Array<{ label: string; phases: ServerUpdatePhase[] }> = [
    { label: '准备升级包', phases: ['preparing', 'prepared'] }, { label: '停止服务', phases: ['stopping'] },
    { label: '安装版本', phases: ['installing'] }, { label: '验证服务', phases: ['verifying'] },
    { label: '重新连接', phases: ['activating', 'complete'] }
  ]
  const stage = stages.findIndex(item => job && item.phases.includes(job.phase))
  const unavailable = !snapshot ? '正在读取升级状态。' : !snapshot.paired ? '请先在资料库连接中连接此服务端。' : null
  const feedbackDetail = [...new Set([error, pollError, environment?.state === 'imageRequired' ? null : environment?.message, job?.message].filter((value): value is string => Boolean(value)))].join('\n\n') || null
  const feedbackMessage = locked ? job?.message ?? '当前服务端任务仍在进行，请等待或按人工恢复指引处理。'
    : imageRequired ? '业务升级无法更新镜像内的运行环境。请先升级服务端 Docker 镜像，再点击“重新检测”。'
      : environmentBusy ? '正在检测服务端运行环境，可查看上次反馈。'
        : environment?.state === 'clientRequired' ? '请先升级此客户端，不要降级服务端镜像。'
          : environmentUnavailable ? '无法确认运行环境，请检查连接后重新检测。'
            : busy && feedbackDetail ? `正在重试，上次反馈：${feedbackDetail}`
              : error ?? pollError ?? unavailable ?? job?.message ?? '运行环境版本必须与本版要求相同。业务升级包不能更新镜像内的管理器及运行库。'
  return <SettingsCard as="section" aria-label="服务端升级" title="服务端升级" className={styles.card} actions={
    <Button variant="ghost" size="sm" className={styles.technicalButton} aria-expanded={technical} onClick={() => setTechnical(value => !value)}>技术信息<ChevronDown {...UI_ICON_SM} /></Button>
  }>
    <div className={styles.content}>
      <p className={styles.status} data-active={locked || busy || environmentBusy || (ready && environmentCompatible) || undefined} role="status" aria-busy={environmentBusy || busy}>
        {locked || busy || environmentBusy ? <LoaderCircle className={styles.spinner} {...UI_ICON} /> : ready && environmentCompatible ? <CheckCircle2 {...UI_ICON} /> : <Info {...UI_ICON} />}
        {busy ? busyAction === 'import' ? '正在上传并校验离线包' : busyAction === 'install' ? '正在提交升级请求' : '正在获取匹配版本的升级包' : message}
      </p>
      <div className={styles.versions}>
        <div><span className={styles.label}>服务端</span><strong className={styles.version}>{serverVersion ?? '—'}</strong></div>
        <ArrowRight className={styles.arrow} {...UI_ICON} />
        <div><span className={styles.label}>此客户端</span><strong className={styles.version}>{clientVersion ?? '—'}</strong></div>
      </div>
      <dl className={styles.environment} aria-label="运行环境版本" aria-busy={environmentBusy}>
        <div className={styles.environmentValue}><dt>当前环境</dt><dd className={styles.environmentRevision}>{environment?.currentVersion == null ? '未确认' : `运行环境版本 ${environment.currentVersion}`}</dd></div>
        <div className={styles.environmentValue} data-separated><dt>本版要求</dt><dd className={styles.environmentRevision}>运行环境版本 {environment?.requiredVersion ?? SERVER_ENVIRONMENT_VERSION}</dd></div>
      </dl>
      <div id={environmentDescriptionId}><SettingsFeedback message={feedbackMessage} error={Boolean(!imageRequired && (error || pollError || job?.phase === 'recoveryRequired' || (environmentUnavailable && !environmentBusy)))} detail={feedbackDetail} detailPresentation="inline" /></div>
      {locked ? <div className={styles.progress}>
        {stage >= 0 && <ol className={styles.stages} aria-label="升级进度">{stages.map((item, index) => <li key={item.label} data-state={index < stage ? 'done' : index === stage ? 'current' : 'pending'} aria-current={index === stage ? 'step' : undefined}>
          {index < stage ? <CheckCircle2 {...UI_ICON_SM} /> : index === stage ? <LoaderCircle {...UI_ICON_SM} className={styles.spinner} /> : <Circle {...UI_ICON_SM} />}{item.label}
        </li>)}</ol>}
        <p className={styles.note}>{job?.phase === 'recoveryRequired' ? job.message : transfer ? `已传输 ${Math.floor(job!.receivedBytes / 1024 ** 2)} / ${Math.ceil(job!.totalBytes / 1024 ** 2)} MiB` : reconnectPending ? '服务端升级完成，正在重新连接资料库。' : '升级期间暂时无法访问与播放，请勿关闭服务端。'}</p>
      </div> : ready && environmentCompatible ? <div className={styles.ready}>
        <div><strong>升级包已就绪</strong><p className={styles.note}>版本与此客户端一致，签名及完整性校验通过。</p></div>
        <Button size="sm" variant="primary" disabled={busy || environmentBusy || !supported || !older} onClick={() => setConfirm(true)}>确认升级</Button>
        <Button size="sm" variant="ghost" disabled={busy || environmentBusy || !supported || !older} onClick={() => { void command({ action: 'import', targetVersion: clientVersion! }).catch(() => {}) }}>重新上传</Button>
      </div> : <div className={styles.entries}>
        <div className={styles.entry}><Button variant={environmentCompatible ? 'primary' : undefined} className={styles.entryButton} busy={busy && busyAction === 'check'} disabled={busy || environmentBusy || !environmentCompatible || !supported || !clientVersion || !older} aria-describedby={environmentDescriptionId} onClick={() => { void command({ action: 'check', targetVersion: clientVersion! }, true).catch(() => {}) }}><CloudDownload {...UI_ICON} />在线升级</Button><p className={styles.note}>从网络获取与此客户端匹配的升级包。</p></div>
        <div className={styles.entry}><Button className={styles.entryButton} busy={busy && busyAction === 'import'} disabled={busy || environmentBusy || !environmentCompatible || !supported || !clientVersion || !older} aria-describedby={environmentDescriptionId} onClick={() => { void command({ action: 'import', targetVersion: clientVersion! }).catch(() => {}) }}><Upload {...UI_ICON} />上传离线包升级</Button><p className={styles.note}>上传匹配版本的官方 .javdex-update 文件。</p></div>
      </div>}
      <div className={styles.environmentActions}>
        {!executing && <Button size="sm" className={styles.environmentAction} variant={imageRequired && !busy ? 'primary' : 'ghost'} aria-haspopup="dialog" onClick={() => setGuide(true)}><BookOpen {...UI_ICON_SM} />查看镜像升级指引</Button>}
        <Button size="sm" className={styles.environmentAction} variant={!locked && !imageRequired && (environmentBusy || environmentUnavailable) ? 'primary' : undefined} busy={environmentBusy} disabled={environmentBusy || busy} onClick={() => { void checkEnvironment() }}><RefreshCw {...UI_ICON_SM} />重新检测</Button>
      </div>
      <div className={styles.footer}><Info {...UI_ICON_SM} /><p className={styles.note}>{executing ? '请等待当前服务端任务结束；安装开始后失败或中断需要人工恢复。' : '升级镜像会中断服务，请保留资料卷、程序卷及图片卷；重要资料请先备份。'}</p></div>
      {technical && <dl className={styles.technical}><dt>架构</dt><dd>{environment?.platform ?? snapshot?.platform ?? '—'}</dd><dt>运行环境</dt><dd>{environment?.runtimeId ?? snapshot?.runtime ?? '—'}</dd></dl>}
    </div>
    {confirm && ready && job && environmentCompatible && !environmentBusy ? <Modal title={`升级服务端至 ${clientVersion}`} confirmText="停服并升级" onCancel={() => setConfirm(false)} onConfirm={async () => {
      await command({ action: 'install', jobId: job.id, targetVersion: clientVersion! })
      setConfirm(false)
    }}><p>升级会暂停服务端访问与播放，完成后重新连接资料库。</p><p>如有重要资料，建议升级前使用与当前服务端版本一致的客户端备份资料库。</p><p>安装开始后失败或中断需要人工恢复。</p></Modal> : null}
    {guide ? <Modal title="服务端Docker镜像升级指引" size="sm" className={styles.guideModal} cancelText="关闭" confirmText="打开官方部署文档" onCancel={() => setGuide(false)} onConfirm={async () => {
      if (!await api.externalLinks.open('https://javdexlabs.github.io/Javdex/server/deploy/')) throw new Error('未能打开官方部署文档，请稍后重试')
    }}>
      <ol className={styles.guideSteps}>
        <li>先使用与当前服务端版本一致的客户端备份重要资料。</li>
        <li>选择与此客户端匹配的固定版本镜像，保留原有资料卷 /data、程序卷 /program、图片卷及部署配置。</li>
        <li>拉取镜像后重新创建容器；仅拉取镜像或重启旧容器不会应用新镜像。</li>
        <li>服务恢复后点击“重新检测”，运行环境版本相同才可继续业务升级。</li>
      </ol>
      <p className={styles.note}>{environment?.state === 'clientRequired' ? '当前运行环境较新，请先升级此客户端，不要降级镜像。' : '升级镜像会中断服务。不要删除卷或降低镜像版本；跨运行库代际时请按官方迁移指引处理。'}</p>
    </Modal> : null}
  </SettingsCard>
}
