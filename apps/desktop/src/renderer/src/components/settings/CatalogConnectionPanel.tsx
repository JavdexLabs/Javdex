import TextInput from '../TextInput'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { RemoteConnectionProbeResult, ThisComputerSettings } from '@shared/desktop/settings'
import type { DesktopSessionState } from '@shared/desktop/session'
import type { ServerConnectionSummary } from '@shared/serverUpdateTypes'
import { CheckCircle2, Circle, FolderOpen, Info, LoaderCircle, Monitor, RotateCw, Server } from 'lucide-react'
import { api } from '../../api'
import { useDesktopSession } from '../../desktop/DesktopSessionContext'
import Button from '../Button'
import SettingsSwitchRow from '../SettingsSwitchRow'
import Modal from '../Modal'
import { UI_ICON, UI_ICON_SM } from '../iconDefaults'
import { SegmentedControl, SegmentedOption } from '../SegmentedControl'
import { SettingsCard } from './SettingsPrimitives'
import SettingsFeedback from './SettingsFeedback'
import SettingsFormActions from './SettingsFormActions'
import WriterAuthorizationForm from './WriterAuthorizationForm'
import ServerUpdatePanel from './ServerUpdatePanel'
import TrustedDevicesPanel from './TrustedDevicesPanel'
import { useSettingsDraft } from '../../settings/useSettingsDraft'
import { useSettingsFormGuard } from '../../settings/SettingsLeaveGuard'
import { settingsPath } from '../../settings/settingsRoutes'
import styles from './CatalogConnectionPanel.module.css'

type ConnectionDraft = {
  mode: 'local' | 'remote'
  remoteBaseUrl: string
}

function connectionAddress(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? ''
  try { return new URL(trimmed).href.replace(/\/+$/, '') } catch { return trimmed.replace(/\/+$/, '') }
}

const SESSION_STATES: Record<DesktopSessionState, { label: string; tone: string }> = {
  starting: { label: '连接中', tone: 'info' },
  available: { label: '已连接', tone: 'success' },
  disconnected: { label: '连接中断', tone: 'warning' },
  claimRequired: { label: '等待首次授权', tone: 'warning' },
  authInvalid: { label: '认证失效', tone: 'warning' },
  versionMismatch: { label: '版本不兼容', tone: 'warning' },
  recoveryRequired: { label: '需要恢复写入权限', tone: 'warning' },
  frozen: { label: '资料库已冻结', tone: 'warning' },
  modePrepRequired: { label: '需要准备资料库', tone: 'warning' }
}

export default function CatalogConnectionPanel(): JSX.Element {
  const { session, reconnect } = useDesktopSession()
  const playerHintId = useId()
  const playerModeHintId = useId()
  const playerProgramHintId = useId()
  const playerPathId = useId()
  const serverAddressId = useId()
  const connectionFeedbackId = useId()
  const [savedSettings, setSavedSettings] = useState<ThisComputerSettings | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [authorizing, setAuthorizing] = useState(false)
  const [connectionSaved, setConnectionSaved] = useState(false)
  const [connectionForgotten, setConnectionForgotten] = useState(false)
  const [connection, setConnection] = useState<ServerConnectionSummary | null>(null)
  const [readingConnection, setReadingConnection] = useState(Boolean(api.serverUpdate))
  const [connectionReadError, setConnectionReadError] = useState<string | null>(null)
  const [forgetting, setForgetting] = useState(false)
  const [confirmForget, setConfirmForget] = useState(false)
  const connectionGeneration = useRef(0)
  const connectionAction = useRef(false)
  const serverAddressInput = useRef<HTMLInputElement>(null)
  const focusAddress = useRef(false)
  const modeButtons = useRef<(HTMLButtonElement | null)[]>([])
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const saved: ConnectionDraft = {
    mode: savedSettings?.mode ?? 'local',
    remoteBaseUrl: savedSettings?.remoteBaseUrl ?? ''
  }
  const form = useSettingsDraft(saved)
  const playerForm = useSettingsDraft({ playerPath: savedSettings?.playerPath ?? '', playerPreference: savedSettings?.playerPreference ?? 'builtin', resumePlayback: savedSettings?.resumePlayback ?? true })
  const externalPlayer = playerForm.draft.playerPreference === 'external'
  const missingPlayerPath = externalPlayer && !playerForm.draft.playerPath.trim()
  const [clearProgress, setClearProgress] = useState(false)
  const [savingPlayer, setSavingPlayer] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<RemoteConnectionProbeResult | null>(null)
  const probeGeneration = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pickingPlayer, setPickingPlayer] = useState(false)
  const [detectingPlayer, setDetectingPlayer] = useState(false)
  const [playerDetectionHint, setPlayerDetectionHint] = useState<string | null>(null)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [sessionBusy, setSessionBusy] = useState(false)
  const pendingModeChange = savedSettings !== null && savedSettings.mode !== session.mode
  const pendingUrlChange = savedSettings?.mode === 'remote' && session.mode === 'remote' &&
    session.remoteBaseUrl != null &&
    savedSettings.remoteBaseUrl !== session.remoteBaseUrl
  const pendingRestart = pendingModeChange || pendingUrlChange
  const invalidateConnectionRequests = useCallback(() => {
    connectionGeneration.current++
    probeGeneration.current++
  }, [])

  useEffect(() => {
    let cancelled = false
    void api.thisComputer.get().then(settings => { if (!cancelled) setSavedSettings(settings) })
      .catch(reason => { if (!cancelled) setError((reason as Error).message) })
    return () => { cancelled = true; invalidateConnectionRequests() }
  }, [invalidateConnectionRequests])

  const draft = form.draft
  const connectionBusy = connecting || authorizing || forgetting || saving
  const activeTarget = session.mode === 'remote' && Boolean(session.remoteBaseUrl) &&
    connectionAddress(draft.remoteBaseUrl) === connectionAddress(session.remoteBaseUrl)
  const targetAuthorized = activeTarget && (session.state === 'available' || session.state === 'frozen') && !connectionForgotten
  const showImportGuide = draft.mode === 'remote' && activeTarget && session.state === 'available' &&
    !pendingRestart && !connectionSaved && !connectionForgotten
  const matchingConnection = connection && connectionAddress(draft.remoteBaseUrl) === connectionAddress(connection.remoteBaseUrl) ? connection : null
  const currentAuthorized = session.mode === 'remote' && (session.state === 'available' || session.state === 'frozen')
  const currentAuthorization = session.mode === 'local' ? '本机访问'
    : currentAuthorized ? '已授权'
    : session.state === 'disconnected' || session.state === 'starting' ? '待连接确认'
    : session.state === 'authInvalid' ? '授权已失效'
    : session.state === 'versionMismatch' ? '待版本匹配' : '待授权'
  const clientVersion = session.desktopAppVersion ?? (session.mode === 'local' ? session.appVersion : null)
  const versionsMatch = Boolean(clientVersion && session.appVersion && clientVersion === session.appVersion)
  const sessionSummary = session.mode === 'local' && session.state === 'available' ? '正在使用这台电脑上的资料库。'
    : session.mode === 'remote' && session.state === 'available' ? versionsMatch ? '连接正常，客户端与服务端版本一致。' : '连接正常。'
    : session.message ?? SESSION_STATES[session.state].label
  const readConnection = useCallback(async (): Promise<void> => {
    if (connectionAction.current) return
    if (!api.serverUpdate) { setReadingConnection(false); return }
    const generation = ++connectionGeneration.current
    setReadingConnection(true)
    setConnectionReadError(null)
    try {
      const result = await api.serverUpdate.control({ action: 'connectionStatus' })
      if (generation === connectionGeneration.current) {
        setConnection(result.connection ?? null)
        setConnectionSaved(Boolean(result.connectionRestartRequired && result.connection))
        setConnectionForgotten(Boolean(result.connectionRestartRequired && !result.connection))
      }
    } catch (reason) {
      if (generation === connectionGeneration.current) setConnectionReadError((reason as Error).message)
    } finally {
      if (generation === connectionGeneration.current) setReadingConnection(false)
    }
  }, [])
  useEffect(() => { void readConnection() }, [readConnection, session.generation, session.serverId, session.catalogId])
  useEffect(() => {
    if (focusAddress.current && draft.mode === 'remote' && !matchingConnection && !readingConnection && !forgetting) {
      serverAddressInput.current?.focus()
      focusAddress.current = false
    }
  }, [draft.mode, matchingConnection, readingConnection, forgetting])
  const selectMode = (mode: ConnectionDraft['mode']): void => {
    if (mode === draft.mode) return
    probeGeneration.current++
    setProbing(false)
    setProbeResult(null)
    setConnectionError(null)
    form.setDraft(current => ({ ...current, mode }))
  }
  const connect = async (oneTimeToken: string): Promise<boolean> => {
    if (connecting || forgetting || saving || connectionAction.current || !oneTimeToken.trim()) return false
    connectionAction.current = true
    const generation = ++connectionGeneration.current
    setConnecting(true)
    setConnectionError(null)
    probeGeneration.current++
    setProbing(false)
    setProbeResult(null)
    try {
      const result = await api.serverUpdate.control({ action: 'connect', remoteBaseUrl: draft.remoteBaseUrl.trim(), oneTimeToken: oneTimeToken.trim() })
      if (generation !== connectionGeneration.current) return false
      setError(null)
      setConnection(result.connection ?? null)
      if (result.connection) form.setDraft({ mode: 'remote', remoteBaseUrl: result.connection.remoteBaseUrl })
      setConnectionSaved(true)
      setConnectionForgotten(false)
      const settings = await api.thisComputer.get()
      if (generation !== connectionGeneration.current) return false
      setSavedSettings(settings)
      form.setDraft({ mode: settings.mode, remoteBaseUrl: settings.remoteBaseUrl ?? '' })
      form.accept({ mode: settings.mode, remoteBaseUrl: settings.remoteBaseUrl ?? '' })
      probeGeneration.current++
      setProbing(false)
      setProbeResult(null)
      return true
    } catch (reason) {
      if (generation === connectionGeneration.current) setConnectionError((reason as Error).message)
      return false
    } finally {
      connectionAction.current = false
      if (generation === connectionGeneration.current) setConnecting(false)
    }
  }
  const forgetConnection = async (): Promise<void> => {
    if (connectionBusy || connectionAction.current) return
    connectionAction.current = true
    const generation = ++connectionGeneration.current
    setForgetting(true)
    setConnectionError(null)
    try {
      await api.serverUpdate.control({ action: 'forgetConnection' })
      if (generation !== connectionGeneration.current) return
      setConnection(null)
      setConnectionSaved(false)
      setConnectionForgotten(true)
      setConfirmForget(false)
      probeGeneration.current++
      setProbing(false)
      setProbeResult(null)
      focusAddress.current = true
    } catch (reason) {
      if (generation === connectionGeneration.current) setConnectionError((reason as Error).message)
      throw reason
    } finally {
      connectionAction.current = false
      if (generation === connectionGeneration.current) setForgetting(false)
    }
  }
  const testConnection = async (address = draft.remoteBaseUrl): Promise<void> => {
    const generation = ++probeGeneration.current
    setProbing(true)
    try {
      const result = await api.thisComputer.probe(address)
      if (generation === probeGeneration.current) setProbeResult(result)
    } catch (reason) {
      if (generation === probeGeneration.current) {
        setProbeResult({
          status: 'unavailable', message: (reason as Error).message,
          serverVersion: null, serverId: null, catalogId: null
        })
      }
    } finally {
      if (generation === probeGeneration.current) setProbing(false)
    }
  }
  const restart = async (): Promise<void> => {
    setRestarting(true)
    setRestartError(null)
    try {
      await api.thisComputer.restart()
    } catch (reason) {
      setRestartError((reason as Error).message)
      setRestarting(false)
    }
  }
  const choosePlayer = async (): Promise<void> => {
    setPickingPlayer(true)
    setPickerError(null)
    setPlayerDetectionHint(null)
    try {
      const selected = await api.thisComputer.pickPlayer(playerForm.draft.playerPath.trim() || null)
      if (selected) playerForm.setDraft(current => ({ ...current, playerPath: selected }))
    } catch (reason) {
      setPickerError((reason as Error).message)
    } finally {
      setPickingPlayer(false)
    }
  }
  const detectPlayer = async (): Promise<void> => {
    setDetectingPlayer(true)
    setPickerError(null)
    setPlayerDetectionHint(null)
    try {
      const result = await api.thisComputer.detectPlayer()
      if (result.status === 'found') {
        playerForm.setDraft(current => ({ ...current, playerPath: result.path }))
        setPlayerDetectionHint(`已选择系统的 ${result.extension} 默认播放器，保存后生效。`)
      } else {
        setPickerError(result.message)
      }
    } catch {
      setPickerError('无法读取系统默认播放器，请重试或点击“选择程序”。')
    } finally {
      setDetectingPlayer(false)
    }
  }
  const save = async (): Promise<boolean> => {
    const submitted = { ...form.draft }
    setSaving(true)
    setError(null)
    try {
      const result = await api.thisComputer.update({
        mode: submitted.mode,
        remoteBaseUrl: submitted.remoteBaseUrl.trim() || null
      })
      setSavedSettings(result.settings)
      form.accept({
        mode: result.settings.mode,
        remoteBaseUrl: result.settings.remoteBaseUrl ?? ''
      }, submitted)
      return true
    } catch (reason) {
      setError((reason as Error).message)
      return false
    } finally {
      setSaving(false)
    }
  }
  const savePlayer = async (): Promise<boolean> => {
    const submitted = { ...playerForm.draft }
    if (submitted.playerPreference === 'external' && !submitted.playerPath.trim()) {
      setPickerError('请选择或输入外部播放器的程序路径后再保存。')
      return false
    }
    setSavingPlayer(true)
    setPickerError(null)
    try {
      const result = await api.thisComputer.update({ playerPath: submitted.playerPath.trim() || null, playerPreference: submitted.playerPreference, resumePlayback: submitted.resumePlayback })
      setSavedSettings(result.settings)
      playerForm.accept({ playerPath: result.settings.playerPath ?? '', playerPreference: result.settings.playerPreference ?? 'builtin', resumePlayback: result.settings.resumePlayback ?? true }, submitted)
      setPlayerDetectionHint(null)
      return true
    } catch (reason) {
      setPickerError((reason as Error).message)
      return false
    } finally {
      setSavingPlayer(false)
    }
  }
  const resetPlayer = (): void => {
    playerForm.reset()
    setPickerError(null)
    setPlayerDetectionHint(null)
  }
  const resetConnection = (): void => {
    form.reset()
    setError(null)
    probeGeneration.current++
    setProbing(false)
    setProbeResult(null)
  }
  useSettingsFormGuard({
    label: '播放器', dirty: playerForm.dirty,
    busy: savingPlayer || detectingPlayer || pickingPlayer,
    save: savePlayer, discard: resetPlayer
  })
  useSettingsFormGuard({
    label: '资料库连接',
    dirty: form.dirty,
    busy: connectionBusy,
    save,
    discard: resetConnection
  })

  return (
    <>
      <SettingsCard as="section" title="当前连接" aria-label="当前连接" className={styles.statusCard}
        headerClassName={styles.statusCardHeader}
        actions={<span className={styles.connectionStatus} data-tone={SESSION_STATES[session.state].tone}>
          <Circle size={8} fill="currentColor" aria-hidden />{SESSION_STATES[session.state].label}
        </span>}>
        <dl className={styles.statusFacts}>
          <div className={styles.statusFact}>
            <dt>资料库模式</dt><dd>{session.mode === 'remote' ? '远程资料库' : '本地资料库'}</dd>
          </div>
          <div className={styles.statusFact}>
            <dt>{session.mode === 'remote' ? '服务器地址' : '资料库位置'}</dt>
            <dd>{session.mode === 'remote' ? session.remoteBaseUrl ?? '未配置' : '这台电脑'}</dd>
          </div>
          <div className={styles.statusFact}>
            <dt>{session.mode === 'remote' ? '写入授权' : '访问权限'}</dt>
            <dd className={currentAuthorized ? styles.authorized : undefined}>
              {currentAuthorized ? <CheckCircle2 {...UI_ICON_SM} aria-hidden /> : null}{currentAuthorization}
            </dd>
          </div>
        </dl>
        <div className={styles.statusFooter}>
          <p className={styles.sessionMessage} role="status">{sessionSummary}</p>
          <dl className={styles.statusVersions} aria-label="应用版本">
            <div><dt>本地版本</dt><dd>{clientVersion ?? '未获取'}</dd></div>
            {session.mode === 'remote' ? <div><dt>服务端版本</dt><dd>{session.appVersion ?? '未获取'}</dd></div> : null}
          </dl>
        </div>
      </SettingsCard>
      <SettingsCard as="section" aria-label="资料库配置"
        title="资料库配置"
        hint="切换模式将在重启后生效，现有资料不会自动转移。"
        className={`${styles.card} ${styles.connectionCard}`}
        actions={
          <SettingsFormActions
            placement="header"
            dirty={form.dirty}
            saving={saving}
            saveLabel="应用配置"
            disabled={readingConnection || connectionBusy || savingPlayer || !savedSettings}
            idleLabel={pendingRestart ? '已保存 · 重启后生效' : '已保存'}
            error={error}
            conflict={form.conflict}
            onSave={() => void save()}
            onCancel={resetConnection}
          />
        }
      >
        <div className={styles.modeChoices} role="radiogroup" aria-label="资料库位置">
          {([
            { mode: 'local', label: '本地资料库', hint: '资料保存在这台电脑', Icon: Monitor },
            { mode: 'remote', label: '远程资料库', hint: '连接服务端管理资料', Icon: Server }
          ] as const).map(({ mode, label, hint, Icon }, index) => <button key={mode} type="button"
            ref={element => { modeButtons.current[index] = element }}
            className={styles.modeChoice} role="radio" aria-label={label} aria-checked={draft.mode === mode}
            tabIndex={draft.mode === mode ? 0 : -1} disabled={connectionBusy || !savedSettings}
            onClick={() => selectMode(mode)} onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index
              selectMode(next === 0 ? 'local' : 'remote')
              modeButtons.current[next]?.focus()
            }}>
            <Icon {...UI_ICON} size={28} aria-hidden />
            <span className={styles.modeCopy}><strong className={styles.modeTitle}>{label}</strong><span className={styles.modeHint}>{hint}</span></span>
            {draft.mode === mode ? <CheckCircle2 {...UI_ICON} className={styles.modeCheck} data-selected="true" aria-hidden /> : <Circle {...UI_ICON} className={styles.modeCheck} aria-hidden />}
          </button>)}
        </div>
        {draft.mode === 'local' ? <div className={styles.localSummary}>
          <strong>本地资料库</strong>
          <p className={styles.localCopy}>使用这台电脑上的资料库，无需配对或连接服务器。</p>
          <p className={`${styles.localCopy} ${styles.localNote}`}><Info {...UI_ICON_SM} aria-hidden />本地与远程资料相互独立，切换不会自动转移资料。</p>
        </div> : <div className={styles.remoteContent}>
          {readingConnection || connectionReadError ? <div className={styles.connectionLoading}>
            <SettingsFeedback message={readingConnection ? '正在读取已保存的配对…' : '无法读取已保存的配对，请重试。'} detail={connectionReadError} error={Boolean(connectionReadError)} />
            {connectionReadError ? <Button size="sm" onClick={() => void readConnection()}>重新读取</Button> : null}
          </div> : <div className={styles.connectionRows}>
            <div className={styles.connectionRow}>
              <label className={styles.connectionLabel} htmlFor={serverAddressId}>服务器地址</label>
              <div className={styles.connectionControls}>
                <div className={styles.urlInputRow}>
                  <TextInput id={serverAddressId} aria-describedby={connectionFeedbackId} ref={serverAddressInput} density="workspace" className={styles.urlInput}
                    value={draft.remoteBaseUrl} disabled={connectionBusy} placeholder="https://192.168.1.10:8096" spellCheck={false}
                    onChange={event => {
                      probeGeneration.current++
                      setProbing(false)
                      setProbeResult(null)
                      setConnectionError(null)
                      form.setDraft({ ...draft, remoteBaseUrl: event.target.value })
                    }} />
                  <Button aria-busy={probing} disabled={connectionBusy || probing || !draft.remoteBaseUrl.trim()}
                    onClick={() => void testConnection()}>测试连接</Button>
                </div>
                <div id={connectionFeedbackId}>
                  <SettingsFeedback
                    message={probing ? '正在测试当前输入的服务器地址…' : probeResult ? probeResult.status === 'reachable' ? '服务可达，版本匹配' : probeResult.message : matchingConnection || targetAuthorized ? '测试当前输入的服务器地址。' : '首次自动接受证书；自签名证书变化时需确认，合法公开证书无需确认。'}
                    error={Boolean(probeResult && probeResult.status !== 'reachable')}
                    detail={probeResult ? [probeResult.message, `服务器版本：${probeResult.serverVersion ?? '—'}`, `服务身份：${probeResult.serverId ?? '—'}`, `资料库身份：${probeResult.catalogId ?? '—'}`].join('\n') : null}
                  />
                </div>
                {activeTarget && session.state === 'disconnected' ? <div className={styles.sessionActions}>
                  <Button size="sm" busy={sessionBusy} disabled={sessionBusy || connectionBusy} onClick={() => {
                    setSessionBusy(true)
                    setSessionError(null)
                    void reconnect().catch(reason => setSessionError((reason as Error).message)).finally(() => setSessionBusy(false))
                  }}>重新连接</Button>
                </div> : null}
                {sessionError ? <p className={styles.sessionError} role="alert">{sessionError}</p> : null}
              </div>
            </div>
            {matchingConnection || targetAuthorized ? <div className={`${styles.connectionRow} ${styles.authorizationRow}`}>
              <span className={styles.connectionLabel}>设备授权</span>
              <div className={styles.connectionControls}>
                <div className={styles.savedAuthorization}>
                  <p className={styles.authorizationCopy}>{matchingConnection ? '已保存此电脑的管理授权。' : '此电脑当前已获得管理授权。'}</p>
                  {matchingConnection ? <Button variant="danger" busy={forgetting} disabled={connectionBusy || savingPlayer}
                    onClick={() => setConfirmForget(true)}>取消配对</Button> : null}
                </div>
                {matchingConnection ? <p className={styles.connectionNote}>取消配对仅移除此电脑的授权，重启后生效；服务端资料保留。</p> : null}
              </div>
            </div> : <WriterAuthorizationForm key={connectionAddress(draft.remoteBaseUrl)}
              targetAddress={draft.remoteBaseUrl} disabled={connectionBusy || savingPlayer || !savedSettings}
              onBusyChange={setAuthorizing} onAuthorize={api.serverUpdate ? connect : undefined} />}
          </div>}
          {connectionError ? <SettingsFeedback message="服务端配对操作失败，请查看详情。" detail={connectionError} error /> : null}
        </div>}
        {pendingRestart || connectionSaved || connectionForgotten ? (
          <div className={styles.restartNotice} role="status">
            <div className={styles.restartCopy}>
              <strong className={styles.restartTitle}>{connectionForgotten ? '已取消配对，重启后生效' : '已保存，等待重启'}</strong>
              <span className={styles.restartTarget}>
                当前使用：{session.mode === 'local' ? '本地资料库' : `远程资料库 · ${session.remoteBaseUrl ?? '地址未知'}`}
                {' → '}
                重启后使用：{savedSettings?.mode === 'local' ? '本地资料库' : `远程资料库 · ${savedSettings?.remoteBaseUrl ?? '地址未知'}`}
              </span>
            </div>
            <Button
              disabled={connectionBusy || form.dirty || playerForm.dirty || savingPlayer || pickingPlayer || detectingPlayer || restarting}
              onClick={() => void restart()}
            >
              <RotateCw {...UI_ICON_SM} aria-hidden />
              立即重启
            </Button>
          </div>
        ) : null}
        {restartError ? <p className={styles.sessionError} role="alert">{restartError}</p> : null}
        {showImportGuide ? (
          <aside className={styles.importGuide} aria-label="从本机资料库导入提示">
            <Info {...UI_ICON} size={24} className={styles.importGuideIcon} />
            <div className={styles.importGuideCopy}>
              <p className={styles.importGuideText}>已有本机资料可导入服务端。</p>
              <p className={styles.importGuideText}>
                完成连接与写入授权后，在「<Link to={settingsPath('storage', 'backup')} draggable={false} className={styles.importGuideLink}>备份与恢复</Link>」中选择「从本机资料库导入」。
              </p>
              <p className={styles.importGuideNote}>将替换服务端现有资料，执行前自动备份；本机资料保留，不上传或修改原始视频，两份资料不自动同步。</p>
            </div>
          </aside>
        ) : null}
      </SettingsCard>
      <TrustedDevicesPanel />
      {confirmForget && matchingConnection ? <Modal title="取消此电脑的配对" danger confirmText="取消配对" onCancel={() => setConfirmForget(false)} onConfirm={forgetConnection}>
        <p>移除此电脑保存的连接和设备凭据，重启后停止使用原授权。服务端资料与其他设备不受影响。</p>
        <p>再次连接需要管理员生成新的一次性令牌。</p>
      </Modal> : null}
      <ServerUpdatePanel />
      <SettingsCard as="section" aria-label="播放器" title="播放器" className={styles.card}
        hint="仅影响此电脑；保存后从下一次播放生效。"
        actions={
          <SettingsFormActions placement="header" dirty={playerForm.dirty} saving={savingPlayer}
            disabled={connectionBusy || pickingPlayer || detectingPlayer || !savedSettings}
            saveDisabled={missingPlayerPath}
            error={pickerError} conflict={playerForm.conflict}
            onSave={() => void savePlayer()} onCancel={resetPlayer} />
        }>
        <div className={styles.playerRows}>
          <div className={styles.playerRow}>
            <span className={styles.playerFieldLabel}>默认播放方式</span>
            <div className={styles.playerRowContent}>
              <SegmentedControl variant="subtle" className={styles.playerModes} aria-label="默认播放方式" aria-describedby={playerModeHintId}>
                {([
                  ['builtin', '内置播放器'], ['external', '外部播放器']
                ] as const).map(([value, label]) => <SegmentedOption key={value} className={styles.playerModeOption}
                  selected={playerForm.draft.playerPreference === value}
                  disabled={savingPlayer || connectionBusy || !savedSettings}
                  onClick={() => {
                    setPickerError(null)
                    setPlayerDetectionHint(null)
                    playerForm.setDraft(current => ({ ...current, playerPreference: value }))
                  }}>{label}</SegmentedOption>)}
              </SegmentedControl>
              <p id={playerModeHintId} className={styles.playerNote}>{externalPlayer
                ? '通过此电脑上的播放程序打开影片。'
                : '内置播放支持本机与远程媒体库的影片文件。'}</p>
            </div>
          </div>
          <div className={styles.playerRow}>
            <div className={styles.playerRowLabel}>
              <label htmlFor={playerPathId} className={styles.playerFieldLabel}>外部播放器程序</label>
              {!externalPlayer ? <span className={styles.playerNote}>备用配置</span> : null}
            </div>
            <div className={styles.playerRowContent}>
              <div className={styles.playerInputRow}>
                <TextInput
                  id={playerPathId}
                  density="workspace"
                  value={playerForm.draft.playerPath}
                  disabled={savingPlayer || connectionBusy || pickingPlayer || detectingPlayer || !savedSettings}
                  spellCheck={false}
                  placeholder="选择程序或输入绝对路径"
                  aria-required={externalPlayer}
                  aria-describedby={`${playerProgramHintId} ${playerHintId}`}
                  onChange={(event) => {
                    setPickerError(null)
                    setPlayerDetectionHint(null)
                    playerForm.setDraft(current => ({ ...current, playerPath: event.target.value }))
                  }}
                />
                <div className={styles.playerButtons}>
                  <Button size="sm" className={styles.playerPickButton}
                    disabled={savingPlayer || connectionBusy || pickingPlayer || detectingPlayer || !savedSettings}
                    onClick={() => void choosePlayer()}>
                    <FolderOpen {...UI_ICON_SM} aria-hidden />
                    选择程序
                  </Button>
                  <Button size="sm" className={styles.defaultPlayerButton}
                    aria-label="使用系统默认播放器"
                    aria-busy={detectingPlayer}
                    title="读取系统为视频文件设置的默认程序，填入后需保存"
                    disabled={savingPlayer || connectionBusy || pickingPlayer || detectingPlayer || !savedSettings} onClick={() => void detectPlayer()}>
                    {detectingPlayer
                      ? <LoaderCircle {...UI_ICON_SM} className={styles.playerBusyIcon} aria-hidden />
                      : <Monitor {...UI_ICON_SM} aria-hidden />}
                    使用系统默认
                  </Button>
                </div>
              </div>
              <div id={playerProgramHintId}>
                <SettingsFeedback message={detectingPlayer ? '正在读取系统默认播放器…' : playerDetectionHint && playerForm.dirty ? playerDetectionHint
                  : missingPlayerPath ? '请先选择或输入程序路径，也可使用系统默认程序。'
                  : externalPlayer ? '服务端影片需使用支持网络播放的程序。'
                  : playerForm.draft.playerPath.trim() ? '已保留的程序路径，切换为外部播放器后使用。'
                  : '可预先指定程序，切换为外部播放器后使用。'} />
              </div>
            </div>
          </div>
          <div className={styles.playerResumeRow}>
            <SettingsSwitchRow title="保存续播进度" description={externalPlayer
              ? '仅适用于内置播放器；外部播放器自行管理续播进度。'
              : '仅在此电脑记录内置播放器的续播位置。'}
              checked={playerForm.draft.resumePlayback} disabled={externalPlayer || savingPlayer || connectionBusy || !savedSettings}
              onChange={resumePlayback => playerForm.setDraft(current => ({ ...current, resumePlayback }))} />
          </div>
          <div className={styles.playerMaintenanceRow}>
            <div className={styles.playerMaintenanceCopy}>
              <span className={styles.playerRowTitle}>本机续播记录</span>
              <p className={styles.playerNote}>清除此电脑所有资料库的续播位置，影片和资料保留。</p>
            </div>
            <Button size="sm" variant="dangerGhost" className={styles.playerClearButton}
              aria-label="清除全部本机续播进度" onClick={() => setClearProgress(true)}>清除进度</Button>
          </div>
        </div>
        <p id={playerHintId} className={styles.playerFooter}><Info {...UI_ICON_SM} />
          <span>其他链接仍由外部播放器打开；内置运行库异常时提示错误，不自动切换。</span>
        </p>
      </SettingsCard>
      {clearProgress && <Modal title="清除全部本机续播进度" confirmText="清除进度" danger onCancel={() => setClearProgress(false)}
        onConfirm={async () => { await api.playback.clearProgress({ scope: 'all' }); setClearProgress(false) }}>
        <p>清除此电脑所有资料库的续播位置，无法撤销。影片和资料保留。当前播放会话停止保存进度；之后的新播放仍按已保存的设置执行。</p>
      </Modal>}

    </>
  )
}
