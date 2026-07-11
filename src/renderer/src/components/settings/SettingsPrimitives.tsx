import type { KeyboardEventHandler, ReactNode, RefObject } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import type { SettingsGroup, SettingsTab, SettingsTabItem } from '../../settings/settingsRoutes'
import { settingsTabDomId, settingsTabPanelDomId } from '../../settings/settingsRoutes'
import EmptyState from '../EmptyState'
import { AppFormField } from '../FormPrimitives'
import { UI_ICON_SM } from '../iconDefaults'

type CardProps = {
  title?: ReactNode
  hint?: ReactNode
  actions?: ReactNode
  className?: string
  children: ReactNode
}

export function SettingsCard({ title, hint, actions, className = '', children }: CardProps): JSX.Element {
  return (
    <div className={`settings-card${className ? ` ${className}` : ''}`}>
      {(title || hint || actions) && (
        <SettingsCardHeader title={title} hint={hint} actions={actions} />
      )}
      {children}
    </div>
  )
}

export function SettingsCardHeader({
  title,
  hint,
  actions
}: {
  title?: ReactNode
  hint?: ReactNode
  actions?: ReactNode
}): JSX.Element {
  return (
    <div className="settings-card-head">
      <div className="settings-card-head-copy">
        {title ? <h3>{title}</h3> : null}
        {hint ? <p className="hint">{hint}</p> : null}
      </div>
      {actions ? <div className="settings-card-actions">{actions}</div> : null}
    </div>
  )
}

/** Compact switch for settings card headers (top-right). */
export function SettingsHeaderSwitch({
  label,
  checked,
  disabled = false,
  onChange
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <label
      className={`settings-header-switch${disabled ? ' settings-header-switch--disabled' : ''}`}
      title={label}
    >
      <span className="ui-switch">
        <input
          type="checkbox"
          role="switch"
          aria-label={label}
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="ui-switch-slider" aria-hidden="true" />
      </span>
    </label>
  )
}

export function SettingsSectionBlock({
  title,
  hint,
  actions,
  className = '',
  children,
  id,
  blockRef
}: {
  title: ReactNode
  hint?: ReactNode
  actions?: ReactNode
  className?: string
  children: ReactNode
  id?: string
  blockRef?: RefObject<HTMLDivElement>
}): JSX.Element {
  return (
    <div id={id} ref={blockRef} className={`settings-section-block${className ? ` ${className}` : ''}`}>
      <div className="settings-section-block-head">
        <div className="settings-section-block-copy">
          <span className="settings-section-block-title">{title}</span>
          {hint ? <span className="settings-section-block-hint">{hint}</span> : null}
        </div>
        {actions ? <div className="settings-section-block-actions">{actions}</div> : null}
      </div>
      {children}
    </div>
  )
}

export function SettingsTabBar({
  group,
  tabs,
  activeTab,
  label,
  className = '',
  onSelect,
  onKeyDown
}: {
  group: SettingsGroup
  tabs: SettingsTabItem[]
  activeTab: SettingsTab
  label: string
  className?: string
  onSelect: (tab: SettingsTab) => void
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>
}): JSX.Element {
  return (
    <div
      className={`settings-tab-bar${className ? ` ${className}` : ''}`}
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          id={settingsTabDomId(group, tab.id)}
          className={`settings-tab-button${activeTab === tab.id ? ' is-active' : ''}`}
          role="tab"
          aria-selected={activeTab === tab.id}
          aria-controls={settingsTabPanelDomId(group, tab.id)}
          tabIndex={activeTab === tab.id ? 0 : -1}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

export function SettingsEmptyPanel({
  children,
  variant = 'plain',
  className = ''
}: {
  children: ReactNode
  variant?: 'plain' | 'dashed' | 'compact'
  className?: string
}): JSX.Element {
  const emptyVariant = variant === 'compact' ? 'compact' : 'panel'
  return (
    <EmptyState
      variant={emptyVariant}
      className={`settings-empty-panel settings-empty-panel--${variant}${className ? ` ${className}` : ''}`}
      description={children}
    />
  )
}

export const SettingsFormField = AppFormField

export function SettingsStatusPill({
  status,
  children,
  className = ''
}: {
  status?: string
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <span className={`settings-status-pill${status ? ` settings-status-pill--${status}` : ''}${className ? ` ${className}` : ''}`}>
      {children}
    </span>
  )
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Compact − value + stepper for dense settings rows. */
export function SettingsNumberStepper({
  value,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  unit,
  disabled = false,
  'aria-label': ariaLabel,
  onChange
}: {
  value: number
  min?: number
  max?: number
  step?: number
  unit?: string
  disabled?: boolean
  'aria-label'?: string
  onChange: (value: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  const [focused, setFocused] = useState(false)
  const valueRef = useRef(value)
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  valueRef.current = value

  useEffect(() => {
    if (!focused) setDraft(String(value))
  }, [focused, value])

  useEffect(() => {
    return () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current)
      if (holdIntervalRef.current) clearInterval(holdIntervalRef.current)
    }
  }, [])

  const commit = (next: number): void => {
    const clamped = clampNumber(Math.round(next), min, max)
    setDraft(String(clamped))
    if (clamped !== valueRef.current) onChange(clamped)
  }

  const nudge = (direction: 1 | -1): void => {
    commit(valueRef.current + direction * step)
  }

  const stopHold = (): void => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
    if (holdIntervalRef.current) {
      clearInterval(holdIntervalRef.current)
      holdIntervalRef.current = null
    }
  }

  const startHold = (direction: 1 | -1): void => {
    if (disabled) return
    nudge(direction)
    stopHold()
    holdTimerRef.current = setTimeout(() => {
      holdIntervalRef.current = setInterval(() => nudge(direction), 60)
    }, 380)
  }

  const atMin = value <= min
  const atMax = value >= max

  return (
    <div
      className={`settings-number-stepper${disabled ? ' settings-number-stepper--disabled' : ''}`}
      role="group"
      aria-label={ariaLabel}
    >
      <button
        type="button"
        className="settings-number-stepper__btn"
        aria-label="减少"
        disabled={disabled || atMin}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          startHold(-1)
        }}
        onPointerUp={stopHold}
        onPointerCancel={stopHold}
        onPointerLeave={stopHold}
      >
        <Minus {...UI_ICON_SM} aria-hidden />
      </button>
      <input
        className="settings-number-stepper__value"
        type="text"
        inputMode="numeric"
        disabled={disabled}
        value={draft}
        aria-label={ariaLabel}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          const raw = e.target.value.trim()
          setDraft(raw)
          if (raw === '' || raw === '-') return
          const parsed = Number(raw)
          if (!Number.isFinite(parsed)) return
          commit(parsed)
        }}
        onBlur={() => {
          setFocused(false)
          const parsed = Number(draft)
          commit(Number.isFinite(parsed) ? parsed : value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            nudge(1)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            nudge(-1)
          } else if (e.key === 'Enter') {
            e.currentTarget.blur()
          }
        }}
      />
      <button
        type="button"
        className="settings-number-stepper__btn"
        aria-label="增加"
        disabled={disabled || atMax}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          startHold(1)
        }}
        onPointerUp={stopHold}
        onPointerCancel={stopHold}
        onPointerLeave={stopHold}
      >
        <Plus {...UI_ICON_SM} aria-hidden />
      </button>
      {unit ? <span className="settings-number-stepper__unit">{unit}</span> : null}
    </div>
  )
}
