import type { KeyboardEventHandler, ReactNode, RefObject } from 'react'
import type { SettingsGroup, SettingsTab, SettingsTabItem } from '../../settings/settingsRoutes'
import { settingsTabDomId, settingsTabPanelDomId } from '../../settings/settingsRoutes'
import { AppFormField } from '../FormPrimitives'

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
  return (
    <div
      className={`settings-empty-panel settings-empty-panel--${variant}${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
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
