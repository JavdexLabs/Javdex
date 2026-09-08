import { useEffect, useRef, useState } from 'react'
import type { WebAccessStatus } from '@shared/webTypes'
import { api } from '../../api'
import { useSettingsDraft } from '../../settings/useSettingsDraft'
import { useSettingsFormGuard } from '../../settings/SettingsLeaveGuard'
import SettingsSwitchRow from '../SettingsSwitchRow'
import Button from '../Button'
import { SettingsCard } from './SettingsPrimitives'
import SettingsFormActions from './SettingsFormActions'
import styles from './WebAccessPanel.module.css'
import WebDevices from './WebDevices'

export default function WebAccessPanel(): JSX.Element {
  const [status, setStatus] = useState<WebAccessStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = (): void => {
    void api.webAccess
      .status()
      .then(setStatus)
      .catch((e) => setError(e.message))
  }
  useEffect(load, [])
  if (!status)
    return (
      <div role="status">
        {error ?? '正在读取 Web 服务状态…'}
        {error && <Button onClick={load}>重试</Button>}
      </div>
    )
  return <WebAccessForm status={status} onChange={setStatus} />
}
function WebAccessForm({
  status,
  onChange
}: {
  status: WebAccessStatus
  onChange: (status: WebAccessStatus) => void
}): JSX.Element {
  const form = useSettingsDraft({
    enabled: status.enabled,
    port: String(status.port),
    username: status.username,
    password: ''
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  const save = async (): Promise<boolean> => {
    if (lock.current) return false
    const submitted = form.draft
    const port = Number(submitted.port)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setError('端口需为 1024–65535 的整数')
      return false
    }
    if (!/^[\w.-]{1,64}$/.test(submitted.username)) {
      setError('账号使用 1–64 位字母、数字、点、横线或下划线')
      return false
    }
    if (
      (submitted.enabled && !status.hasPassword && !submitted.password) ||
      (submitted.password &&
        (submitted.password.length < 12 || submitted.password.length > 128))
    ) {
      setError('请设置 12–128 个字符的访问密码')
      return false
    }
    lock.current = true
    setSaving(true)
    setError(null)
    try {
      const next = await api.webAccess.apply({
        ...submitted,
        port,
        password: submitted.password || undefined
      })
      onChange(next)
      form.accept(
        {
          enabled: next.enabled,
          port: String(next.port),
          username: next.username,
          password: ''
        },
        submitted
      )
      return !next.error
    } catch (reason) {
      setError((reason as Error).message)
      return false
    } finally {
      lock.current = false
      setSaving(false)
    }
  }
  useSettingsFormGuard({
    label: '局域网 Web 访问',
    dirty: form.dirty,
    busy: saving,
    save,
    discard: form.reset
  })
  return (
    <SettingsCard
      title="局域网 Web 访问"
      hint="在手机、平板、电脑或电视浏览媒体库。Web 端只读，管理操作仍在桌面端完成。"
    >
      <div className={styles.form}>
        <SettingsSwitchRow
          title="启用 Web 服务"
          description="保存后生效；Javdex 退出后停止服务。"
          checked={form.draft.enabled}
          disabled={saving}
          onChange={(enabled) => form.setDraft((d) => ({ ...d, enabled }))}
        />
        <div className={styles.fields}>
          <label className={styles.field}>
            端口
            <input
              className={`text-input ${styles.input}`}
              inputMode="numeric"
              value={form.draft.port}
              disabled={saving}
              onChange={(e) =>
                form.setDraft((d) => ({ ...d, port: e.target.value }))
              }
            />
          </label>
          <label className={styles.field}>
            访问账号
            <input
              className={`text-input ${styles.input}`}
              autoComplete="off"
              value={form.draft.username}
              disabled={saving}
              onChange={(e) =>
                form.setDraft((d) => ({ ...d, username: e.target.value }))
              }
            />
          </label>
          <label className={styles.field}>
            {status.hasPassword ? '更换密码（留空保留）' : '访问密码'}
            <input
              className={`text-input ${styles.input}`}
              type="password"
              autoComplete="new-password"
              maxLength={128}
              value={form.draft.password}
              disabled={saving}
              onChange={(e) =>
                form.setDraft((d) => ({ ...d, password: e.target.value }))
              }
            />
          </label>
        </div>
        <p className={styles.hint}>
          使用独立的 12 位以上密码。当前使用局域网
          HTTP，请仅在可信网络使用，不要将端口映射到公网。可浏览所有活动媒体库中的可见影片，支持浏览器原生播放，不进行转码。
        </p>
        <div className={styles.status} aria-live="polite">
          <strong>{status.running ? '服务运行中' : '服务未运行'}</strong>
          {(error || status.error) && (
            <p className={styles.statusCopy} role="alert">{error || status.error}</p>
          )}
          {status.urls.map((url) => (
            <div key={url} className={styles.address}>
              <code className={styles.url}>{url}</code>
              <Button
                size="sm"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(url)
                    .catch(() => setError('复制失败，请手动复制地址'))
                }
              >
                复制地址
              </Button>
            </div>
          ))}
          {status.running && (
            <p>
              其他设备使用非 127.0.0.1
              的地址；需连接同一局域网，并允许系统防火墙访问此端口。
            </p>
          )}
        </div>
        <div className={styles.actions}>
          <Button
            disabled={saving}
            onClick={() =>
              void api.webAccess
                .status()
                .then(onChange)
                .catch((e) => setError(e.message))
            }
          >
            刷新状态
          </Button>
          <Button
            disabled={saving}
            onClick={() =>
              void api.webAccess
                .revoke()
                .then(onChange)
                .catch((e) => setError(e.message))
            }
          >
            退出所有浏览器会话
          </Button>
          {status.enabled && !status.running && (
            <Button disabled={saving} onClick={() => void save()}>
              重试启动
            </Button>
          )}
        </div>
        <WebDevices status={status} onChange={onChange} />
        <SettingsFormActions
          dirty={form.dirty}
          saving={saving}
          onSave={() => void save()}
          onCancel={form.reset}
        />
      </div>
    </SettingsCard>
  )
}
