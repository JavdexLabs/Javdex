import type { KeyboardEventHandler, ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import {
  SETTINGS_GROUPS,
  settingsPath,
  settingsTabDomId,
  settingsTabPanelDomId,
  type SettingsGroupItem,
  type SettingsGroup,
  type SettingsTab
} from '../../settings/settingsRoutes'
import { SettingsTabBar } from './SettingsPrimitives'

export function SettingsPluginDevShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="scroll-body scroll-body--fill">
      <div className="scroll-body-inner scroll-body-inner--settings settings-dev-page">
        {children}
      </div>
    </div>
  )
}

export default function SettingsWorkspaceShell({
  activeGroup,
  activeTab,
  onNavigate,
  onTabKeyDown,
  hrefForGroup,
  tabsPlacement = 'shell',
  children
}: {
  activeGroup: SettingsGroupItem
  activeTab: SettingsTab
  onNavigate: (group: SettingsGroup, tab?: SettingsTab) => void
  onTabKeyDown: KeyboardEventHandler<HTMLDivElement>
  hrefForGroup?: (group: SettingsGroupItem) => string
  tabsPlacement?: 'shell' | 'content'
  children: ReactNode
}): JSX.Element {
  const shellOwnsTabs = tabsPlacement === 'shell'
  return (
    <div className="scroll-body scroll-body--fill">
      <div className="scroll-body-inner scroll-body-inner--settings settings-overview-page">
        <nav className="settings-group-tabs" aria-label="设置分类">
          {SETTINGS_GROUPS.map((group) => (
            <NavLink
              key={group.id}
              to={hrefForGroup?.(group) ?? settingsPath(group.id)}
              className={`settings-group-tab${activeGroup.id === group.id ? ' is-active' : ''}`}
              aria-current={activeGroup.id === group.id ? 'page' : undefined}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                ) {
                  return
                }
                event.preventDefault()
                onNavigate(group.id)
              }}
            >
              {group.label}
            </NavLink>
          ))}
        </nav>

        <div className="settings-scroll-region">
          <main
            id="settings-main-panel"
            className="settings-content"
            role="region"
            aria-label={`${activeGroup.label}设置`}
          >
            {shellOwnsTabs && activeGroup.tabs.length > 1 ? (
              <SettingsTabBar
                group={activeGroup.id}
                tabs={activeGroup.tabs}
                activeTab={activeTab}
                label={`${activeGroup.label}设置页签`}
                onSelect={(tab) => onNavigate(activeGroup.id, tab)}
                onKeyDown={onTabKeyDown}
              />
            ) : null}

            <section
              className="settings-section"
              role={shellOwnsTabs ? 'tabpanel' : undefined}
              id={
                shellOwnsTabs
                  ? settingsTabPanelDomId(activeGroup.id, activeTab)
                  : undefined
              }
              aria-labelledby={
                shellOwnsTabs && activeGroup.tabs.length > 1
                  ? settingsTabDomId(activeGroup.id, activeTab)
                  : undefined
              }
              aria-label={
                shellOwnsTabs && activeGroup.tabs.length === 1
                  ? activeGroup.label
                  : undefined
              }
            >
              {children}
            </section>
          </main>
        </div>
      </div>
    </div>
  )
}
