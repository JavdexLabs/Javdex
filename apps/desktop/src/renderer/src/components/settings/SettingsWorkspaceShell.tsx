import ScrollViewport from '../ScrollViewport'
import { useLayoutEffect, useRef, type KeyboardEventHandler, type ReactNode } from 'react'
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
import styles from './SettingsWorkspaceShell.module.css'

export function SettingsPluginDevShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <ScrollViewport variant="fill">
      <div data-page-content className={`${styles.root} ${styles.pluginDevPage}`}>
        {children}
      </div>
    </ScrollViewport>
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
  const scrollRegion = useRef<HTMLDivElement>(null)
  const scrollPositions = useRef(new Map<string, number>())
  const pageKey = `${activeGroup.id}/${activeTab}`
  useLayoutEffect(() => {
    if (scrollRegion.current) scrollRegion.current.scrollTop = scrollPositions.current.get(pageKey) ?? 0
  }, [pageKey])
  return (
    <ScrollViewport variant="fill">
      <div data-page-content className={`${styles.root} ${styles.overviewPage}`}>
        <nav className={styles.groupTabs} aria-label="设置分类">
          {SETTINGS_GROUPS.map((group) => (
            <NavLink
              draggable={false}
              key={group.id}
              to={hrefForGroup?.(group) ?? settingsPath(group.id)}
              className={styles.groupTab}
              data-active={activeGroup.id === group.id}
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
        <div className={styles.scrollRegion} ref={scrollRegion} data-settings-scroll-region
          onScroll={(event) => scrollPositions.current.set(pageKey, event.currentTarget.scrollTop)}>
          <main
            id="settings-main-panel"
            className={styles.content}
            role="region"
            aria-label={`${activeGroup.label}设置`}
          >
            <section
              className={styles.section}
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
    </ScrollViewport>
  )
}
