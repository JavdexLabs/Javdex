import { useId, useRef, useState } from 'react'
import type { SettingsSnapshot } from '@shared/settingsTypes'
import { api } from '../../api'
import { useSettingsDraft } from '../../settings/useSettingsDraft'
import { useSettingsFormGuard } from '../../settings/SettingsLeaveGuard'
import Button from '../Button'
import Modal from '../Modal'
import { CheckCircle2, CircleAlert, Info, LoaderCircle } from 'lucide-react'
import { UI_ICON_SM } from '../iconDefaults'
import SelectControl from '../SelectControl'
import { SettingsCard } from './SettingsPrimitives'
import SettingsFormActions from './SettingsFormActions'
import styles from './NetworkSettingsPanel.module.css'

export function ProxyConfigRow({
  kind,
  savedValue,
  enabled,
  onSaved
}: {
  kind: 'scrape' | 'llm'
  savedValue: string
  enabled: boolean
  onSaved: (patch: Partial<SettingsSnapshot>) => void
}): JSX.Element {
  const label = kind === 'scrape' ? '刮削代理' : 'AI 模型代理'
  const id = useId()
  const form = useSettingsDraft({ url: savedValue, enabled })
  const { draft } = form
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    url: string
    message: string
    ok: boolean
  } | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const savingRef = useRef(false)
  const save = async (): Promise<boolean> => {
    if (savingRef.current) return false
    const next = { ...draft, url: draft.url.trim() }
    if (next.enabled && !next.url) {
      setError('使用代理时，请填写代理地址。')
      return false
    }
    if (next.url) {
      try {
        const url = new URL(next.url)
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
      } catch {
        setError(
          '请输入完整的 HTTP / HTTPS 代理地址，例如 http://127.0.0.1:7890。'
        )
        return false
      }
    }
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const patch =
        kind === 'scrape'
          ? { proxyUrl: next.url, proxyUrlEnabled: next.enabled }
          : { llmProxyUrl: next.url, llmProxyUrlEnabled: next.enabled }
      await api.settings.update(patch)
      onSaved(patch)
      form.accept(next, form.draft)
      return true
    } catch (reason) {
      setError((reason as Error).message)
      return false
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  useSettingsFormGuard({
    label,
    dirty: form.dirty,
    busy: saving,
    save,
    discard: form.reset
  })
  const test = async (): Promise<void> => {
    const url = draft.url.trim()
    setTesting(true)
    setResult(null)
    try {
      setResult({
        url,
        message: await api.settings.testProxy(kind, url),
        ok: true
      })
    } catch (reason) {
      setResult({ url, message: (reason as Error).message, ok: false })
    } finally {
      setTesting(false)
    }
  }
  const stale = result && result.url !== draft.url.trim()
  const feedback = error
    ? { tone: 'error', summary: error, detail: error }
    : form.conflict
      ? {
          tone: 'error',
          summary: '配置已在其他位置更新，你的输入已保留。',
          detail: '取消更改可读取最新配置，保存会提交当前输入。'
        }
      : testing
        ? { tone: 'pending', summary: '正在测试输入的代理地址…', detail: null }
        : stale
          ? { tone: 'muted', summary: '地址已更改，请重新测试。', detail: null }
          : result
            ? {
                tone: result.ok ? 'success' : 'error',
                summary: result.ok ? '测试通过' : '测试失败，请查看详情',
                detail: result.message
              }
            : {
                tone: 'muted',
                summary: draft.enabled
                  ? '地址与连接方式一起保存后生效。'
                  : '当前使用直连；保留的代理地址不会被使用。',
                detail: null
              }
  const FeedbackIcon =
    feedback.tone === 'pending'
      ? LoaderCircle
      : feedback.tone === 'success'
        ? CheckCircle2
        : feedback.tone === 'error'
          ? CircleAlert
          : Info
  return (
    <>
      <SettingsCard
        className={styles.card}
        title={label}
        hint={
          kind === 'scrape'
            ? '影片、演员刮削及浏览器验证'
            : '模型查询、测试生成与 AI 助手请求'
        }
        actions={
          <SettingsFormActions placement="header"
            dirty={form.dirty}
            saving={saving}
            onSave={() => void save()}
            onCancel={() => {
              form.reset()
              setError(null)
              setResult(null)
            }}
          />
        }
      >
        <div className={styles.form}>
          <label className={styles.field}>
            <span>连接方式</span>
            <SelectControl
              disabled={saving}
              value={draft.enabled ? 'proxy' : 'direct'}
              onChange={(event) =>
                form.setDraft({
                  ...draft,
                  enabled: event.target.value === 'proxy'
                })
              }
            >
              <option value="direct">直接连接</option>
              <option value="proxy">使用代理</option>
            </SelectControl>
          </label>
          <div className={styles.field}>
            <label htmlFor={id}>代理地址</label>
            <div className={styles.addressRow}>
              <input
                id={id}
                className="text-input"
                value={draft.url}
                disabled={saving}
                placeholder="http://127.0.0.1:7890"
                aria-describedby={`${id}-hint`}
                aria-invalid={Boolean(error)}
                onChange={(event) => {
                  form.setDraft({ ...draft, url: event.target.value })
                  setError(null)
                }}
              />
              <Button
                size="sm"
                className={styles.testButton}
                aria-describedby={`${id}-test-hint`}
                disabled={testing || saving || !draft.url.trim()}
                onClick={() => void test()}
              >
                {testing ? '测试中…' : '测试连接'}
              </Button>
            </div>
            <small id={`${id}-test-hint`} className={styles.testHint}>
              测试使用当前地址，不保存配置，也不会启用代理。
            </small>
          </div>
        </div>
        <div className={styles.feedback} data-tone={feedback.tone}>
          <FeedbackIcon
            {...UI_ICON_SM}
            className={testing ? styles.spinning : undefined}
            aria-hidden
          />
          <span
            id={`${id}-hint`}
            className={styles.feedbackText}
            role="status"
            title={feedback.summary}
          >
            {feedback.summary}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className={
              feedback.detail ? styles.detailsButton : styles.detailsHidden
            }
            tabIndex={feedback.detail ? 0 : -1}
            aria-hidden={!feedback.detail}
            onClick={() => setDetailsOpen(true)}
          >
            查看详情
          </Button>
        </div>
      </SettingsCard>
      {detailsOpen && feedback.detail ? (
        <Modal
          title={`${label} · ${error || form.conflict ? '配置提示' : '测试详情'}`}
          onCancel={() => setDetailsOpen(false)}
          hideCancel
          confirmText="关闭"
          onConfirm={() => setDetailsOpen(false)}
        >
          <p className={styles.detailText}>{feedback.detail}</p>
        </Modal>
      ) : null}
    </>
  )
}

export default function NetworkSettingsPanel({
  settings,
  onSaved
}: {
  settings: SettingsSnapshot
  onSaved: (patch: Partial<SettingsSnapshot>) => void
}): JSX.Element {
  return (
    <>
      <ProxyConfigRow
        kind="scrape"
        savedValue={settings.proxyUrl}
        enabled={settings.proxyUrlEnabled}
        onSaved={onSaved}
      />
      <ProxyConfigRow
        kind="llm"
        savedValue={settings.llmProxyUrl}
        enabled={settings.llmProxyUrlEnabled}
        onSaved={onSaved}
      />
    </>
  )
}
