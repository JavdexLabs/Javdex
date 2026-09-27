import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { RemoteConnectionProbeResult, ThisComputerSettings } from '@shared/desktop/settings'
import type { DesktopSessionState } from '@shared/desktop/session'
import { ArrowRight, FolderOpen, LoaderCircle, Monitor, RotateCw } from 'lucide-react'
import { api } from '../../api'
import { useDesktopSession } from '../../desktop/DesktopSessionContext'
import Button from '../Button'
import { AppFormField } from '../FormPrimitives'
import { UI_ICON_SM } from '../iconDefaults'
import SelectControl from '../SelectControl'
import { SettingsCard, SettingsStatusPill } from './SettingsPrimitives'
import SettingsFeedback from './SettingsFeedback'
import SettingsFormActions from './SettingsFormActions'
import WriterAuthorizationForm from './WriterAuthorizationForm'
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
  const navigate = useNavigate()
  const { session, reconnect } = useDesktopSession()
  const playerHintId = useId()
  const [savedSettings, setSavedSettings] = useState<ThisComputerSettings | null>(null)
  const saved: ConnectionDraft = {
    mode: savedSettings?.mode ?? 'local',
    remoteBaseUrl: savedSettings?.remoteBaseUrl ?? ''
  }
  const form = useSettingsDraft(saved)
  const playerForm = useSettingsDraft({ playerPath: savedSettings?.playerPath ?? '' })
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
      if (selected) playerForm.setDraft({ playerPath: selected })
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
        playerForm.setDraft({ playerPath: result.path })
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
    setSavingPlayer(true)
    setPickerError(null)
    try {
      const result = await api.thisComputer.update({ playerPath: submitted.playerPath.trim() || null })
      setSavedSettings(result.settings)
      playerForm.accept({ playerPath: result.settings.playerPath ?? '' }, submitted)
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
        <details className={styles.details}>
          <summary className={styles.detailsSummary}>连接详情</summary>
          <dl className={styles.detailsList}>
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
        </details>
      </SettingsCard>
      <SettingsCard
        title="资料库连接"
        hint="切换连接在重启后生效，现有资料不会自动转移。"
        className={`${styles.card} ${styles.connectionCard}`}
        actions={pendingRestart ? <SettingsStatusPill status="warning">等待重启</SettingsStatusPill> : undefined}
      >
        <div className={styles.fields}>
          <AppFormField className={styles.connectionField} label="资料库位置" hint={draft.mode === 'local' ? '资料保存在这台电脑。' : '资料保存在服务端。'}>
            <SelectControl
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
                <input
                  className={`text-input ${styles.urlInput}`}
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
        <SettingsFormActions
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
            <div className={styles.importGuideCopy}>
              <strong className={styles.importGuideTitle}>将已有本机资料导入服务端</strong>
              <p className={styles.importGuideText}>如果之前使用本地资料库，切换到服务端后，可导入已整理的影片资料、图片、清单和评分。</p>
              <p className={styles.importGuideText}>先在本页连接服务端并完成写入授权，再前往「存储与导出 → 备份与恢复 → 从本机资料库导入」，按向导对应服务端资源目录并核对恢复影响。</p>
              <p className={styles.importGuideNote}>导入会替换服务端现有资料，执行前自动备份。本机资料保留，两份资料不自动同步；原始视频不会上传。</p>
            </div>
            <Button size="sm" className={styles.importGuideButton} onClick={() => navigate(settingsPath('storage', 'backup'))}>
              前往备份与恢复 <ArrowRight {...UI_ICON_SM} aria-hidden />
            </Button>
          </aside>
        ) : null}
      </SettingsCard>
        {draft.mode === 'remote' || session.mode === 'remote' ? (
          <SettingsCard title="播放器" className={styles.card}
            hint={playerForm.draft.playerPath.trim()
              ? `${playerForm.dirty ? '待保存程序' : '当前程序'}：${playerForm.draft.playerPath.trim().split(/[\\/]/).pop()}`
              : '播放服务端视频需设置这台电脑上的播放器。'}>
            <div className={styles.playerInputRow}>
              <AppFormField label="播放器程序" className={styles.playerPathField}>
                <input
                  className="text-input"
                  value={playerForm.draft.playerPath}
                  disabled={savingPlayer || saving || pickingPlayer || detectingPlayer}
                  spellCheck={false}
                  placeholder="选择程序或输入绝对路径"
                  aria-describedby={playerHintId}
                  onChange={(event) => {
                    setPickerError(null)
                    setPlayerDetectionHint(null)
                    playerForm.setDraft({ playerPath: event.target.value })
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
            <div id={playerHintId}>
              <SettingsFeedback message={detectingPlayer ? '正在读取系统默认播放器…' : playerDetectionHint && playerForm.dirty ? playerDetectionHint : '用于播放服务端视频及视频直链，播放器需支持网络播放。'} />
            </div>
            <SettingsFormActions dirty={playerForm.dirty} saving={savingPlayer}
              disabled={saving || pickingPlayer || detectingPlayer || !savedSettings}
              error={pickerError} conflict={playerForm.conflict}
              onSave={() => void savePlayer()} onCancel={resetPlayer} />
          </SettingsCard>
        ) : null}

    </>
  )
}
