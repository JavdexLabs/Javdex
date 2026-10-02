import { useOutletContext } from 'react-router-dom'
import { Suspense, type ReactNode } from 'react'
import EmptyState from '../components/EmptyState'

export interface SettingsRouteOutletContext {
  settingsPage: ReactNode
  pluginDevPage: ReactNode
}

export function SettingsSectionOutlet(): JSX.Element {
  const { settingsPage } = useOutletContext<SettingsRouteOutletContext>()
  return <Suspense fallback={<EmptyState loading />}>{settingsPage}</Suspense>
}

export function SettingsPluginDevOutlet(): JSX.Element {
  const { pluginDevPage } = useOutletContext<SettingsRouteOutletContext>()
  return <Suspense fallback={<EmptyState loading />}>{pluginDevPage}</Suspense>
}
