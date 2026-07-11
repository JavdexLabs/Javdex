import { useOutletContext } from 'react-router-dom'
import type { ReactNode } from 'react'

export interface SettingsRouteOutletContext {
  settingsPage: ReactNode
  pluginDevPage: ReactNode
}

export function SettingsSectionOutlet(): JSX.Element {
  const { settingsPage } = useOutletContext<SettingsRouteOutletContext>()
  return <>{settingsPage}</>
}

export function SettingsPluginDevOutlet(): JSX.Element {
  const { pluginDevPage } = useOutletContext<SettingsRouteOutletContext>()
  return <>{pluginDevPage}</>
}
