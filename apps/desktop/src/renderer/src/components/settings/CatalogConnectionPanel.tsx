import { useEffect, useState } from 'react'
import type { ThisComputerSettings } from '@shared/desktop/settings'
import { api } from '../../api'
import { useDesktopSession } from '../../desktop/DesktopSessionContext'
import Button from '../Button'
import { AppFormField } from '../FormPrimitives'
import SelectControl from '../SelectControl'
import { SettingsCard } from './SettingsPrimitives'
import SettingsFormActions from './SettingsFormActions'
import { useSettingsDraft } from '../../settings/useSettingsDraft'
import { useSettingsFormGuard } from '../../settings/SettingsLeaveGuard'
import styles from './NetworkSettingsPanel.module.css'

type ConnectionDraft = { mode: 'local' | 'remote'; remoteBaseUrl: string }

export default function CatalogConnectionPanel(): JSX.Element {
  const { session, reconnect, claimWriter } = useDesktopSession()
  const [savedSettings, setSavedSettings] = useState<ThisComputerSettings | null>(null)
  const saved: ConnectionDraft = {
    mode: savedSettings?.mode ?? 'local',
    remoteBaseUrl: savedSettings?.remoteBaseUrl ?? ''
  }
  const form = useSettingsDraft(saved)
  const [restartRequired, setRestartRequired] = useState(false)
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.thisComputer.get().then(setSavedSettings)
  }, [])

  const draft = form.draft
  const save = async (): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.thisComputer.update({
        mode: draft.mode,
        remoteBaseUrl: draft.mode === 'remote' ? draft.remoteBaseUrl.trim() || null : null
      })
      setSavedSettings(result.settings)
      setRestartRequired(result.restartRequired)
      form.accept({
        mode: result.settings.mode,
        remoteBaseUrl: result.settings.remoteBaseUrl ?? ''
      })
      return true
    } catch (reason) {
      setError((reason as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }
  useSettingsFormGuard({
    label: '资料库连接',
    dirty: form.dirty,
    busy,
    save,
    discard: () => {
      form.reset()
      setError(null)
    }
  })

  return (
    <>
      <SettingsCard
        title="资料库连接"
        hint="模式与服务器地址保存在此电脑，下次启动生效。不会把写入凭据交给页面。"
      >
        <div className={styles.form}>
          <AppFormField label="运行模式" hint="远程模式不会打开本机权威库，也不会启动本机扫描或网页服务。">
            <SelectControl
              value={draft.mode}
              disabled={busy}
              onChange={(event) => form.setDraft({ ...draft, mode: event.target.value as 'local' | 'remote' })}
            >
              <option value="local">本地资料库</option>
              <option value="remote">远程资料库</option>
            </SelectControl>
          </AppFormField>
          {draft.mode === 'remote' ? (
            <AppFormField label="服务器地址" hint="例如 http://192.168.1.10:8096">
              <input
                className="text-input"
                value={draft.remoteBaseUrl}
                disabled={busy}
                placeholder="http://127.0.0.1:8096"
                onChange={(event) => form.setDraft({ ...draft, remoteBaseUrl: event.target.value })}
              />
            </AppFormField>
          ) : null}
        </div>
        <SettingsFormActions
          dirty={form.dirty}
          saving={busy}
          error={error}
          conflict={form.conflict}
          onSave={() => void save()}
          onCancel={() => {
            form.reset()
            setError(null)
          }}
        />
        {restartRequired ? (
          <p className={styles.testHint}>已保存。请重启应用后使用新的连接模式。</p>
        ) : null}
      </SettingsCard>
      <SettingsCard title="当前会话" hint={`generation ${session.generation}`}>
        <p className={styles.testHint}>
          {session.mode === 'remote' ? '远程' : '本地'} · {session.state}
          {session.catalogId ? ` · ${session.catalogId}` : ''}
          {session.message ? ` · ${session.message}` : ''}
        </p>
        {session.mode === 'remote' && session.state !== 'available' ? (
          <div className={styles.addressRow}>
            <Button
              size="sm"
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
          </div>
        ) : null}
        {session.state === 'recoveryRequired' || session.state === 'disconnected' ? (
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault()
              setBusy(true)
              setError(null)
              void claimWriter({
                kind: session.writerEpoch && session.writerEpoch > 0 ? 'deployRecover' : 'initialBind',
                oneTimeToken: token.trim()
              })
                .catch((reason) => setError((reason as Error).message))
                .finally(() => setBusy(false))
            }}
          >
            <AppFormField label="一次性领取令牌" hint="页面只提交令牌。长期写入秘密保存在主进程。">
              <input
                className="text-input"
                value={token}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setToken(event.target.value)}
              />
            </AppFormField>
            <Button type="submit" size="sm" disabled={busy || token.trim().length < 32}>
              领取写入凭据
            </Button>
          </form>
        ) : null}
      </SettingsCard>
    </>
  )
}
