import { generatePath, matchPath } from 'react-router-dom'
import { ROUTE_PATH } from '../listView/routePaths'
import {
  MEDIA_LIBRARY_SETTINGS_TABS,
  MEDIA_LIBRARY_SETTINGS_TAB_LABELS,
  type MediaLibrarySettingsTab
} from '../listView/mediaLibraryRoutes'

/** Overview card, network tab and settings panel share this user-facing name. */
export const WEB_ACCESS_LABEL = '网页服务'

export type SettingsGroup =
  'overview' | 'library' | 'plugins' | 'models' | 'appearance' | 'storage' | 'network' | 'about'

export type SettingsTab =
  | 'status'
  | MediaLibrarySettingsTab
  | 'video'
  | 'providers'
  | 'theme'
  | 'assets'
  | 'proxy'
  | 'web'
  | 'info'
  | 'usage'
  | 'advanced'
  | 'actress'
  | 'export'

export interface SettingsTabItem {
  id: SettingsTab
  label: string
}

export interface SettingsGroupItem {
  id: SettingsGroup
  label: string
  hint: string
  defaultTab: SettingsTab
  tabs: SettingsTabItem[]
}

export const SETTINGS_GROUPS: SettingsGroupItem[] = [
  {
    id: 'overview',
    label: '概览',
    hint: '关键状态',
    defaultTab: 'status',
    tabs: [{ id: 'status', label: '状态' }]
  },
  {
    id: 'library',
    label: '媒体库',
    hint: '来源与扫描',
    defaultTab: 'sources',
    tabs: MEDIA_LIBRARY_SETTINGS_TABS.map((id) => ({
      id,
      label: MEDIA_LIBRARY_SETTINGS_TAB_LABELS[id]
    }))
  },
  {
    id: 'plugins',
    label: '刮削来源',
    hint: '管理与默认来源',
    defaultTab: 'video',
    tabs: [
      { id: 'video', label: '影片' },
      { id: 'actress', label: '演员' }
    ]
  },
  {
    id: 'models',
    label: 'AI 模型',
    hint: 'LLM 供应商',
    defaultTab: 'usage',
    tabs: [
      { id: 'usage', label: '用途与运行' },
      { id: 'providers', label: '提供商与模型' },
      { id: 'advanced', label: '高级' }
    ]
  },
  {
    id: 'appearance',
    label: '外观与隐私',
    hint: '主题配色',
    defaultTab: 'theme',
    tabs: [{ id: 'theme', label: '主题' }]
  },
  {
    id: 'storage',
    label: '存储与导出',
    hint: '资源路径',
    defaultTab: 'assets',
    tabs: [
      { id: 'assets', label: '图片资源' },
      { id: 'export', label: '导出影片资料' }
    ]
  },
  {
    id: 'network',
    label: '网络',
    hint: `${WEB_ACCESS_LABEL}与代理`,
    defaultTab: 'web',
    tabs: [{ id: 'web', label: WEB_ACCESS_LABEL }, { id: 'proxy', label: '代理' }]
  },
  {
    id: 'about',
    label: '关于',
    hint: '版本与项目信息',
    defaultTab: 'info',
    tabs: [{ id: 'info', label: '关于 Javdex' }]
  }
]

export const SETTINGS_GROUP_BY_ID = new Map(SETTINGS_GROUPS.map((group) => [group.id, group]))

export function resolveSettingsRoute(pathname: string): {
  group: SettingsGroupItem
  tab: SettingsTab
} {
  const match = matchPath({ path: ROUTE_PATH.settingsGroup, end: true }, pathname)
  const groupId = match?.params.group as SettingsGroup | undefined
  const group = (groupId && SETTINGS_GROUP_BY_ID.get(groupId)) || SETTINGS_GROUPS[0]
  const tabId = match?.params.tab as SettingsTab | undefined
  const tab = tabId && group.tabs.some((item) => item.id === tabId) ? tabId : group.defaultTab
  return { group, tab }
}

export function settingsPath(group: SettingsGroup, tab?: SettingsTab): string {
  const config = SETTINGS_GROUP_BY_ID.get(group) ?? SETTINGS_GROUPS[0]
  return generatePath(ROUTE_PATH.settingsGroup, {
    group: config.id,
    tab: tab ?? config.defaultTab
  })
}

export function settingsPluginDevPath(): string {
  return ROUTE_PATH.settingsPluginDev
}

export function settingsTabDomId(group: SettingsGroup, tab: SettingsTab): string {
  return `settings-tab-${group}-${tab}`
}

export function settingsTabPanelDomId(group: SettingsGroup, tab: SettingsTab): string {
  return `settings-tabpanel-${group}-${tab}`
}
