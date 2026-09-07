import type { AriaAttributes, KeyboardEventHandler, ReactNode, RefObject } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import type { SettingsGroup, SettingsTab, SettingsTabItem } from '../../settings/settingsRoutes'
import { settingsTabDomId, settingsTabPanelDomId } from '../../settings/settingsRoutes'
import EmptyState from '../EmptyState'
import { AppFormField } from '../FormPrimitives'
import { UI_ICON_SM } from '../iconDefaults'
import Switch from '../Switch'
import styles from './SettingsPrimitives.module.css'

type CardProps = {
  as?: 'div' | 'section'
  title?: ReactNode
  hint?: ReactNode
  actions?: ReactNode
  className?: string
  children: ReactNode
} & Pick<AriaAttributes, 'aria-label' | 'aria-labelledby'>

const STATUS_CLASSES: Record<string, string> = {
  running: styles.statusRunning,
  paused: styles.statusPaused,
  done: styles.statusDone,
  cancelled: styles.statusCancelled,
  success: styles.statusSuccess,
  warning: styles.statusWarning,
  info: styles.statusInfo,
  muted: styles.statusMuted
}

export function SettingsCard({
  as: Component = 'div',
  title,
  hint,
  actions,
  className = '',
  children,
  ...ariaProps
}: CardProps): JSX.Element {
  return (
    <Component
      className={`${styles.card} settings-card${className ? ` ${className}` : ''}`}
      {...ariaProps}
    >
      {(title || hint || actions) && (
        <SettingsCardHeader title={title} hint={hint} actions={actions} />
      )}
      {children}
    </Component>
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
    <div className={`${styles.cardHead} settings-card-head`}>
      <div className={`${styles.cardHeadCopy} settings-card-head-copy`}>
        {title ? <h3>{title}</h3> : null}
        {hint ? <p className={styles.cardHint}>{hint}</p> : null}
      </div>
      {actions ? (
        <div className={`${styles.cardActions} settings-card-actions`}>{actions}</div>
      ) : null}
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
      className={`${styles.headerSwitch}${disabled ? ` ${styles.headerSwitchDisabled}` : ''} settings-header-switch`}
      title={label}
    >
      <Switch
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
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
    <div
      id={id}
      ref={blockRef}
      className={`${styles.sectionBlock}${className ? ` ${className}` : ''}`}
    >
      <div className={styles.sectionBlockHead}>
        <div className={styles.sectionBlockCopy}>
          <span className={styles.sectionBlockTitle}>{title}</span>
          {hint ? <span className={styles.sectionBlockHint}>{hint}</span> : null}
        </div>
        {actions ? <div className={styles.sectionBlockActions}>{actions}</div> : null}
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
      className={`${styles.tabBar}${className ? ` ${className}` : ''}`}
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
          className={`${styles.tabButton}${activeTab === tab.id ? ` ${styles.tabButtonActive}` : ''}`}
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
  const statusClass = STATUS_CLASSES[status ?? '']

  return (
    <span
      className={`${styles.statusPill}${statusClass ? ` ${statusClass}` : ''} settings-status-pill${className ? ` ${className}` : ''}`}
      data-status={status}
    >
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
  const focused = useRef(false)
  const errorId = useId()
  const [invalid, setInvalid] = useState(false)
  const valueRef = useRef(value)
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const holdValueRef = useRef(value)
  valueRef.current = value

  useEffect(() => {
    if (!focused.current) {
      setDraft(String(value))
      setInvalid(false)
    }
  }, [value])

  useEffect(() => {
    return () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current)
      if (holdIntervalRef.current) clearInterval(holdIntervalRef.current)
    }
  }, [])

  const commit = (next: number): void => {
    const clamped = clampNumber(Math.round(next), min, max)
    setDraft(String(clamped))
    setInvalid(false)
    if (clamped !== valueRef.current) onChange(clamped)
  }

  const nudge = (direction: 1 | -1): void => {
    commit(valueRef.current + direction * step)
  }

  const stopHold = (): void => {
    const wasHolding = holdTimerRef.current !== null || holdIntervalRef.current !== null
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
    if (holdIntervalRef.current) {
      clearInterval(holdIntervalRef.current)
      holdIntervalRef.current = null
    }
    if (wasHolding) commit(holdValueRef.current)
  }

  const startHold = (direction: 1 | -1): void => {
    if (disabled) return
    stopHold()
    holdValueRef.current = clampNumber(valueRef.current + direction * step, min, max)
    setDraft(String(holdValueRef.current))
    holdTimerRef.current = setTimeout(() => {
      holdIntervalRef.current = setInterval(() => {
        holdValueRef.current = clampNumber(holdValueRef.current + direction * step, min, max)
        setDraft(String(holdValueRef.current))
      }, 60)
    }, 380)
  }

  const atMin = value <= min
  const atMax = value >= max

  return (
    <div className={styles.stepperField}>
      <div
        className={`${styles.numberStepper}${disabled ? ` ${styles.numberStepperDisabled}` : ''} settings-number-stepper`}
        role="group"
        aria-label={ariaLabel}
      >
        <button
          type="button"
          className={styles.stepperButton}
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
          onClick={(event) => {
            if (event.detail === 0) nudge(-1)
          }}
        >
          <Minus {...UI_ICON_SM} aria-hidden />
        </button>
        <input
          className={`${styles.stepperValue} settings-number-stepper__value`}
          type="text"
          inputMode="numeric"
          disabled={disabled}
          value={draft}
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          title={invalid ? `请输入 ${min}–${max} 之间的整数` : undefined}
          onFocus={() => {
            focused.current = true
          }}
          onChange={(e) => {
            setDraft(e.target.value)
            setInvalid(false)
          }}
          onBlur={() => {
            focused.current = false
            if (!draft.trim()) {
              setDraft(String(value))
              return
            }
            const parsed = Number(draft)
            if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
              setInvalid(true)
              return
            }
            commit(parsed)
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
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setDraft(String(value))
              setInvalid(false)
            }
          }}
        />
        <button
          type="button"
          className={styles.stepperButton}
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
          onClick={(event) => {
            if (event.detail === 0) nudge(1)
          }}
        >
          <Plus {...UI_ICON_SM} aria-hidden />
        </button>
        {unit ? (
          <span className={`${styles.stepperUnit} settings-number-stepper__unit`}>{unit}</span>
        ) : null}
      </div>
      {invalid ? (
        <span id={errorId} className={styles.stepperError} role="alert">
          请输入 {min}–{max} 之间的整数
        </span>
      ) : null}
    </div>
  )
}
