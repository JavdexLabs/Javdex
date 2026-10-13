import TextInput from '../TextInput'
import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { RemoteConnectionProbeResult, ThisComputerSettings } from '@shared/desktop/settings'
import type { DesktopSessionState } from '@shared/desktop/session'
import { FolderOpen, Info, LoaderCircle, Monitor, RotateCw } from 'lucide-react'
import { api } from '../../api'
import { useDesktopSession } from '../../desktop/DesktopSessionContext'
import Button from '../Button'
import SettingsSwitchRow from '../SettingsSwitchRow'
import Modal from '../Modal'
import { AppFormField } from '../FormPrimitives'
import { UI_ICON, UI_ICON_SM } from '../iconDefaults'
import SelectControl from '../SelectControl'
import { SettingsCard, SettingsDisclosure, SettingsStatusPill } from './SettingsPrimitives'
import SettingsFeedback from './SettingsFeedback'
import SettingsFormActions from './SettingsFormActions'
import WriterAuthorizationForm from './WriterAuthorizationForm'
import ServerUpdatePanel from './ServerUpdatePanel'
import { useSettingsDraft } from '../../settings/useSettingsDraft'
import { useSettingsFormGuard } from '../../settings/SettingsLeaveGuard'
import { settingsPath } from '../../settings/settingsRoutes'
import styles from './CatalogConnectionPanel.module.css'

type ConnectionDraft = {
  mode: 'local' | 'remote'
  remoteBaseUrl: string
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
  const [savedSettings, setSavedSettings] = useState<ThisComputerSettings | null>(null)
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

  useEffect(() => {
    void api.thisComputer.get().then(setSavedSettings)
  }, [])

  const draft = form.draft
  const testConnection = async (): Promise<void> => {
    const generation = ++probeGeneration.current
    setProbing(true)
    try {
      const result = await api.thisComputer.probe(draft.remoteBaseUrl)
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
  useSettingsFormGuard({
    label: '播放器', dirty: playerForm.dirty,
    busy: savingPlayer || detectingPlayer || pickingPlayer,
    save: savePlayer, discard: resetPlayer
  })
  useSettingsFormGuard({
    label: '资料库连接',
    dirty: form.dirty,
    busy: saving,
    save,
    discard: () => {
      form.reset()
      setError(null)
    }
  })

  return (
    <>
      <SettingsCard
        className={styles.card}
      >
        <div className={styles.sessionHeader}>
          <span className={styles.factLabel}>当前连接</span>
          <strong>{session.mode === 'remote' ? '远程资料库' : '本地资料库'}</strong>
          {session.mode === 'remote' && session.remoteBaseUrl ? <span className={styles.sessionAddress}>{session.remoteBaseUrl}</span> : null}
          <span className={styles.sessionStatus}><SettingsStatusPill status={SESSION_STATES[session.state].tone}>{SESSION_STATES[session.state].label}</SettingsStatusPill></span>
        </div>
        {session.message ? <p className={styles.sessionMessage} role="status">{session.message}</p> : null}
        {session.mode === 'remote' && session.state === 'disconnected' && session.remoteBaseUrl ? (
          <div className={styles.sessionActions}>
            <Button
              size="sm"
              disabled={sessionBusy}
              onClick={() => {
                setSessionBusy(true)
                setSessionError(null)
                void reconnect()
                  .catch((reason) => setSessionError((reason as Error).message))
                  .finally(() => setSessionBusy(false))
              }}
            >
              重新连接
            </Button>
          </div>
        ) : null}
        {session.mode === 'remote' &&
          (session.state === 'claimRequired' || session.state === 'recoveryRequired' || session.state === 'authInvalid') ? (
          <WriterAuthorizationForm />
        ) : null}
        {sessionError ? <p className={styles.sessionError} role="alert">{sessionError}</p> : null}
        <SettingsDisclosure title="连接详情">
          <dl className={styles.detailsList}>
            <div className={styles.detailsRow}>
              <dt className={styles.detailsLabel}>本地版本</dt><dd className={styles.detailsValue}>{session.desktopAppVersion ?? (session.mode === 'local' ? session.appVersion : null) ?? '未获取'}</dd>
            </div>
            {session.mode === 'remote' ? (
              <div className={styles.detailsRow}>
                <dt className={styles.detailsLabel}>服务端版本</dt><dd className={styles.detailsValue}>{session.appVersion ?? '未获取'}</dd>
              </div>
            ) : null}
            <div className={styles.detailsRow}>
              <dt className={styles.detailsLabel}>会话代次</dt><dd className={styles.detailsValue}>{session.generation}</dd>
            </div>
            {session.catalogId ? (
              <div className={styles.detailsRow}>
                <dt className={styles.detailsLabel}>资料库 ID</dt><dd className={styles.detailsValue}>{session.catalogId}</dd>
              </div>
            ) : null}
            {session.serverId ? (
              <div className={styles.detailsRow}>
                <dt className={styles.detailsLabel}>服务端 ID</dt><dd className={styles.detailsValue}>{session.serverId}</dd>
              </div>
            ) : null}
          </dl>
        </SettingsDisclosure>
      </SettingsCard>
      <ServerUpdatePanel />
      <SettingsCard
        title="资料库连接"
        hint="切换连接在重启后生效，现有资料不会自动转移。"
        className={`${styles.card} ${styles.connectionCard}`}
        actions={
          <SettingsFormActions
            placement="header"
            dirty={form.dirty}
            saving={saving}
            saveLabel="应用连接"
            disabled={savingPlayer || !savedSettings}
            idleLabel={pendingRestart ? '已保存 · 重启后生效' : '已保存'}
            error={error}
            conflict={form.conflict}
            onSave={() => void save()}
            onCancel={() => {
              form.reset()
              setError(null)
            }}
          />
        }
      >
        <div className={styles.fields}>
          <AppFormField className={styles.connectionField} label="资料库位置" hint={draft.mode === 'local' ? '资料保存在这台电脑。' : '资料保存在服务端。'}>
            <SelectControl
              aria-label="资料库位置"
              value={draft.mode}
              disabled={saving}
              onChange={(event) => {
                probeGeneration.current += 1
                setProbing(false)
                setProbeResult(null)
                form.setDraft({ ...draft, mode: event.target.value as 'local' | 'remote' })
              }}
            >
              <option value="local">本地资料库</option>
              <option value="remote">远程资料库</option>
            </SelectControl>
          </AppFormField>
          {draft.mode === 'remote' ? (
            <AppFormField className={styles.connectionField} label="服务器地址">
              <div className={styles.urlInputRow}>
                <TextInput
                  density="workspace" className={styles.urlInput}
                  value={draft.remoteBaseUrl}
                  disabled={saving}
                  placeholder="http://192.168.1.10:8096"
                  spellCheck={false}
                  onChange={(event) => {
                    probeGeneration.current += 1
                    setProbing(false)
                    setProbeResult(null)
                    form.setDraft({ ...draft, remoteBaseUrl: event.target.value })
                  }}
                />
                <Button aria-busy={probing}
                  disabled={saving || probing || !draft.remoteBaseUrl.trim()}
                  onClick={() => void testConnection()}
                >测试连接</Button>
              </div>
              <div className={styles.probeResult}>
                <span className={styles.probeSummary} role="status" tabIndex={probeResult ? 0 : undefined} title={probing ? '正在测试当前输入的服务器地址…' : probeResult?.message}
                  data-tone={probeResult?.status === 'reachable' ? 'success' : probeResult ? 'warning' : undefined}>
                  {probing ? '正在测试当前输入的服务器地址…' : probeResult ? (
                    probeResult.status === 'reachable' ? '服务可达，版本匹配' : probeResult.message
                  ) : '填写服务端地址；127.0.0.1 仅指这台电脑。'}
                </span>

              </div>
            </AppFormField>
          ) : null}
        </div>
        {pendingRestart ? (
          <div className={styles.restartNotice} role="status">
            <div className={styles.restartCopy}>
              <strong className={styles.restartTitle}>已保存，等待重启</strong>
              <span className={styles.restartTarget}>
                当前使用：{session.mode === 'local' ? '本地资料库' : `远程资料库 · ${session.remoteBaseUrl ?? '地址未知'}`}
                {' → '}
                重启后使用：{savedSettings?.mode === 'local' ? '本地资料库' : `远程资料库 · ${savedSettings?.remoteBaseUrl ?? '地址未知'}`}
              </span>
            </div>
            <Button
              disabled={form.dirty || playerForm.dirty || saving || savingPlayer || pickingPlayer || detectingPlayer || restarting}
              onClick={() => void restart()}
            >
              <RotateCw {...UI_ICON_SM} aria-hidden />
              立即重启
            </Button>
          </div>
        ) : null}
        {restartError ? <p className={styles.sessionError} role="alert">{restartError}</p> : null}
        {session.mode === 'remote' ? (
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
          <SettingsCard title="播放器" className={styles.card}
            hint="仅影响此电脑；保存后从下一次播放生效。"
            actions={
              <SettingsFormActions placement="header" dirty={playerForm.dirty} saving={savingPlayer}
                disabled={saving || pickingPlayer || detectingPlayer || !savedSettings}
                saveDisabled={missingPlayerPath}
                error={pickerError} conflict={playerForm.conflict}
                onSave={() => void savePlayer()} onCancel={resetPlayer} />
            }>
            <div className={styles.playerFields}>
            <AppFormField label="默认播放方式">
              <SelectControl aria-label="默认播放方式" value={playerForm.draft.playerPreference}
                disabled={savingPlayer || saving || !savedSettings}
                onChange={event => {
                  setPickerError(null)
                  setPlayerDetectionHint(null)
                  playerForm.setDraft(current => ({ ...current, playerPreference: event.target.value as 'builtin' | 'external' }))
                }}>
                <option value="builtin">内置播放器</option>
                <option value="external">外部播放器</option>
              </SelectControl>
            </AppFormField>
            <SettingsDisclosure title={playerForm.draft.playerPreference === 'external' ? '外部播放器程序' : '外部播放器程序 · 保留的备用配置'} defaultOpen={playerForm.draft.playerPreference === 'external'}>
            <div className={styles.playerInputRow}>
              <AppFormField label="播放器程序" className={styles.playerPathField}>
                <TextInput
                  density="workspace"
                  value={playerForm.draft.playerPath}
                  disabled={savingPlayer || saving || pickingPlayer || detectingPlayer}
                  spellCheck={false}
                  placeholder="选择程序或输入绝对路径"
                  aria-required={externalPlayer}
                  aria-describedby={playerHintId}
                  onChange={(event) => {
                    setPickerError(null)
                    setPlayerDetectionHint(null)
                    playerForm.setDraft(current => ({ ...current, playerPath: event.target.value }))
                  }}
                />
              </AppFormField>
              <div className={styles.playerButtons}>
                <Button
                  className={styles.playerPickButton}
                  disabled={savingPlayer || saving || pickingPlayer || detectingPlayer}
                  onClick={() => void choosePlayer()}
                >
                  <FolderOpen {...UI_ICON_SM} aria-hidden />
                  选择程序
                </Button>
                <Button className={styles.defaultPlayerButton}
                  aria-busy={detectingPlayer}
                  title="读取系统为视频文件设置的默认程序，填入后需保存"
                  disabled={savingPlayer || saving || pickingPlayer || detectingPlayer} onClick={() => void detectPlayer()}>
                  {detectingPlayer
                    ? <LoaderCircle {...UI_ICON_SM} className={styles.playerBusyIcon} aria-hidden />
                    : <Monitor {...UI_ICON_SM} aria-hidden />}
                  使用系统默认播放器
                </Button>
              </div>
            </div>
            </SettingsDisclosure>
            <SettingsSwitchRow title="保存续播进度" description={externalPlayer
              ? '仅适用于内置播放器；外部播放器自行管理续播进度。'
              : '仅在此电脑保存内置播放进度；关闭后停止记录，开启后从下次播放生效。'}
              checked={playerForm.draft.resumePlayback} disabled={externalPlayer || savingPlayer || saving || !savedSettings}
              onChange={resumePlayback => playerForm.setDraft(current => ({ ...current, resumePlayback }))} />
            <Button size="sm" variant="ghost" className={styles.playerClearButton} onClick={() => setClearProgress(true)}>清除全部本机续播进度</Button>
            </div>
            <div id={playerHintId}>
              <SettingsFeedback message={detectingPlayer ? '正在读取系统默认播放器…' : playerDetectionHint && playerForm.dirty ? playerDetectionHint : playerForm.draft.playerPreference === 'builtin'
                ? '内置播放支持本机/远程媒体库的影片文件；其它链接仍外部打开。运行库不可用时提示错误，不自动切换播放器。'
                : missingPlayerPath ? '请先选择或输入程序路径，也可点击“使用系统默认播放器”填入路径后保存。'
                : '外部程序用于本机及服务端影片文件；播放及续播进度由外部播放器管理，服务端影片需指定支持网络播放的程序。'} />
            </div>
          </SettingsCard>
          {clearProgress && <Modal title="清除全部本机续播进度" confirmText="清除进度" danger onCancel={() => setClearProgress(false)}
            onConfirm={async () => { await api.playback.clearProgress({ scope: 'all' }); setClearProgress(false) }}>
            <p>清除此电脑所有资料库的续播位置，无法撤销。影片和资料保留。当前播放会话停止保存进度；之后的新播放仍按已保存的设置执行。</p>
          </Modal>}

    </>
  )
}
