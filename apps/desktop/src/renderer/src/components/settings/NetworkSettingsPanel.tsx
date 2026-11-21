import { useId, useRef, useState } from 'react'
import { Bot, CircleAlert, CircleCheck, Download, Link2, RefreshCw, ScanSearch } from 'lucide-react'
import {
  isManualProxyUrl,
  NETWORK_PROXY_FEATURES,
  NETWORK_PROXY_FEATURE_LABELS,
  NETWORK_PROXY_ROUTE_LABELS,
  networkProxySettings,
  type NetworkProxyFeature,
  type NetworkProxyRoute,
  type NetworkProxySettings
} from '@shared/networkProxy'
import type { SettingsSnapshot } from '@shared/settingsTypes'
import { api } from '../../api'
import { useSettingsDraft } from '../../settings/useSettingsDraft'
import { useSettingsFormGuard } from '../../settings/SettingsLeaveGuard'
import Button from '../Button'
import { UI_ICON, UI_ICON_SM } from '../iconDefaults'
import { SegmentedControl, SegmentedOption } from '../SegmentedControl'
import SelectControl from '../SelectControl'
import TextInput from '../TextInput'
import { SettingsCard } from './SettingsPrimitives'
import SettingsFormActions from './SettingsFormActions'
import styles from './NetworkSettingsPanel.module.css'

const INVALID_ADDRESS = '请输入有效的 HTTP / HTTPS 代理地址'
const ROUTE_MODES = ['system', 'manual', 'direct'] as const
const DEFAULT_ROUTE_HINTS = {
  system: '系统未配置代理时直接连接',
  manual: '支持 HTTP / HTTPS 代理',
  direct: '请求直接连接目标服务'
}
const FEATURE_ICONS = { scrape: ScanSearch, llm: Bot, updates: RefreshCw, downloads: Download }

function ProxyConnectionRow({ feature, route, defaultRoute, onChange, disabled, validateAddress }: {
  feature?: NetworkProxyFeature
  route?: NetworkProxyRoute
  defaultRoute: NetworkProxyRoute
  onChange: (route: NetworkProxyRoute | undefined) => void
  disabled: boolean
  validateAddress: boolean
}): JSX.Element {
  const effective = route ?? defaultRoute
  const title = feature ? NETWORK_PROXY_FEATURE_LABELS[feature] : '默认连接'
  const fieldId = useId()
  const feedbackId = `${fieldId}-feedback`
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ route: NetworkProxyRoute; message: string; failed: boolean }>()
  const currentResult = JSON.stringify(result?.route) === JSON.stringify(effective) ? result : undefined
  const test = async (): Promise<void> => {
    const testedRoute = effective.mode === 'manual' ? { ...effective, url: effective.url.trim() } : effective
    if (testedRoute.mode === 'manual' && !isManualProxyUrl(testedRoute.url)) {
      setResult({ route: effective, message: INVALID_ADDRESS, failed: true })
      return
    }
    setTesting(true)
    setResult(undefined)
    try {
      setResult({ route: effective, message: await api.settings.testProxy(feature ?? 'updates', testedRoute), failed: false })
    } catch (error) {
      setResult({ route: effective, message: (error as Error).message, failed: true })
    } finally {
      setTesting(false)
    }
  }
  const changeMode = (mode: string): void => {
    if (mode === 'inherit') onChange(undefined)
    else if (mode === 'manual') onChange({ mode, url: effective.mode === 'manual' ? effective.url : '' })
    else if (mode === 'system' || mode === 'direct') onChange({ mode })
  }
  const fallback = feature && route?.mode !== 'manual'
    ? (route ? '使用单独设置' : NETWORK_PROXY_ROUTE_LABELS[defaultRoute.mode])
    : DEFAULT_ROUTE_HINTS[effective.mode]
  const addressInvalid = route?.mode === 'manual' && (currentResult?.message === INVALID_ADDRESS
    || (validateAddress && !isManualProxyUrl(route.url.trim())))
  const status = addressInvalid ? INVALID_ADDRESS : testing ? '正在测试连接…' : currentResult?.message ?? fallback
  const tone = addressInvalid || currentResult?.failed ? 'error' : currentResult ? 'success' : undefined
  const StatusIcon = tone === 'error' ? CircleAlert : tone === 'success' ? CircleCheck : undefined
  const feedback = (
    <span
      id={feedbackId}
      className={styles.feedback}
      data-tone={tone}
      role="status"
      title={status}
    >
      {StatusIcon && <StatusIcon {...UI_ICON_SM} />}
      <span className={styles.feedbackText}>{status}</span>
    </span>
  )
  const testButton = (
    <Button
      className={styles.test}
      size="sm"
      busy={testing}
      disabled={disabled}
      aria-label={`测试${title}${feature ? '连接' : ''}`}
      title={feature ? undefined : '通过应用更新服务器测试'}
      onClick={() => void test()}
    >
      测试连接
    </Button>
  )
  const manualEditor = route?.mode === 'manual' && (
    <div className={styles.manualEditor}>
      <label className={styles.addressLabel} htmlFor={fieldId}>代理地址</label>
      <div className={styles.addressControls}>
        <div className={styles.addressField}>
          <Link2 {...UI_ICON_SM} />
          <TextInput
            id={fieldId}
            className={styles.addressInput}
            density="workspace"
            type={route.url.includes('@') ? 'password' : 'text'}
            value={route.url}
            aria-label={`${title}代理地址`}
            aria-describedby={feedbackId}
            aria-invalid={addressInvalid || undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder="http://127.0.0.1:7890"
            disabled={disabled}
            onChange={(event) => onChange({ mode: 'manual', url: event.target.value })}
          />
        </div>
        {testButton}
      </div>
      {feedback}
    </div>
  )
  if (!feature) {
    return (
      <div className={styles.defaultConnection}>
        <div className={styles.defaultControls}>
          <SegmentedControl variant="subtle" className={styles.modes} aria-label="默认连接方式">
            {ROUTE_MODES.map((mode) => (
              <SegmentedOption key={mode} selected={effective.mode === mode} disabled={disabled} onClick={() => changeMode(mode)}>
                {NETWORK_PROXY_ROUTE_LABELS[mode]}
              </SegmentedOption>
            ))}
          </SegmentedControl>
          {!manualEditor && testButton}
        </div>
        {manualEditor || feedback}
      </div>
    )
  }
  const FeatureIcon = FEATURE_ICONS[feature]
  return (
    <div className={styles.feature}>
      <div className={styles.featureLead}>
        <span className={styles.featureIcon}><FeatureIcon {...UI_ICON} /></span>
        <div className={styles.featureCopy}>
          <span className={styles.featureTitle}>{title}</span>
          {!manualEditor && feedback}
        </div>
      </div>
      <div className={styles.featureControls}>
        <SelectControl
          aria-label={`${title}连接方式`}
          value={route?.mode ?? 'inherit'}
          disabled={disabled}
          onChange={(event) => changeMode(event.target.value)}
          buttonClassName={styles.select}
        >
          <option value="inherit">继承默认连接</option>
          {ROUTE_MODES.map((mode) => <option key={mode} value={mode}>{NETWORK_PROXY_ROUTE_LABELS[mode]}</option>)}
        </SelectControl>
        {!manualEditor && testButton}
      </div>
      {manualEditor}
    </div>
  )
}

export default function NetworkSettingsPanel({ settings, onSaved }: {
  settings: SettingsSnapshot
  onSaved: (patch: Partial<SettingsSnapshot>) => void
}): JSX.Element {
  const form = useSettingsDraft(networkProxySettings(settings))
  const { draft } = form
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const save = async (): Promise<boolean> => {
    if (savingRef.current) return false
    const next = structuredClone(draft)
    for (const route of [next.default, ...Object.values(next.overrides)]) {
      if (route?.mode !== 'manual') continue
      route.url = route.url.trim()
      if (!isManualProxyUrl(route.url)) {
        setError(INVALID_ADDRESS)
        return false
      }
    }
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const patch = { networkProxy: next }
      await api.settings.update(patch)
      onSaved(patch)
      form.accept(next, draft)
      return true
    } catch (reason) {
      setError((reason as Error).message)
      return false
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  const reset = (): void => {
    form.reset()
    setError(null)
  }
  useSettingsFormGuard({ label: '网络代理', dirty: form.dirty, busy: saving, save, discard: reset })
  const change = (key: 'default' | NetworkProxyFeature, route: NetworkProxyRoute | undefined): void => {
    setError(null)
    if (key === 'default') {
      if (route) form.setDraft({ ...draft, default: route })
      return
    }
    const overrides: NetworkProxySettings['overrides'] = { ...draft.overrides }
    if (route) overrides[key] = route
    else delete overrides[key]
    form.setDraft({ ...draft, overrides })
  }
  const overrideCount = Object.keys(draft.overrides).length
  return (
    <div className={styles.panel}>
      <SettingsCard
        title="默认连接"
        hint="适用于未单独指定连接方式的功能"
        headerClassName={styles.defaultHeader}
        actions={<SettingsFormActions
          placement="header"
          dirty={form.dirty}
          saving={saving}
          error={error}
          conflict={form.conflict}
          onSave={() => void save()}
          onCancel={reset}
        />}
      >
        <ProxyConnectionRow
          route={draft.default}
          defaultRoute={draft.default}
          onChange={(route) => change('default', route)}
          disabled={saving}
          validateAddress={error === INVALID_ADDRESS}
        />
      </SettingsCard>
      <SettingsCard
        as="section"
        aria-label="按功能设置"
        title="按功能设置"
        actions={<span className={styles.featureSummary}>{overrideCount ? `${overrideCount} 项单独设置` : '全部继承默认连接'}</span>}
      >
        <div className={styles.featureRows}>
          {NETWORK_PROXY_FEATURES.map((feature) => (
            <ProxyConnectionRow
              key={feature}
              feature={feature}
              route={draft.overrides[feature]}
              defaultRoute={draft.default}
              onChange={(route) => change(feature, route)}
              disabled={saving}
              validateAddress={error === INVALID_ADDRESS}
            />
          ))}
        </div>
      </SettingsCard>
    </div>
  )
}
