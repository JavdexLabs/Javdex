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
  | 'local'
  | 'theme'
  | 'assets'
  | 'proxy'
  | 'web'
  | 'mode'
  | 'info'
  | 'usage'
  | 'advanced'
  | 'actress'
  | 'backup'
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
    label: 'AI 服务',
    hint: '功能、云端服务与本地模型',
    defaultTab: 'usage',
    tabs: [
      { id: 'usage', label: '功能' },
      { id: 'providers', label: '云端服务' },
      { id: 'local', label: '本地模型' }
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
    hint: '资料库与资源路径',
    defaultTab: 'mode',
    tabs: [
      { id: 'mode', label: '资料库连接' },
      { id: 'assets', label: '图片资源' },
      { id: 'backup', label: '备份与恢复' },
      { id: 'export', label: '导出影片资料' }
    ]
  },
  {
    id: 'network',
    label: '网络',
    hint: `${WEB_ACCESS_LABEL}与代理`,
    defaultTab: 'web',
    tabs: [
      { id: 'web', label: WEB_ACCESS_LABEL },
      { id: 'proxy', label: '代理' }
    ]
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
  if (pathname === '/settings/network/mode') {
    return { group: SETTINGS_GROUP_BY_ID.get('storage')!, tab: 'mode' }
  }
  if (pathname === '/settings/models/advanced') {
    return { group: SETTINGS_GROUP_BY_ID.get('models')!, tab: 'providers' }
  }
  const match = matchPath({ path: ROUTE_PATH.settingsGroup, end: true }, pathname)
  const groupId = match?.params.group as SettingsGroup | undefined
  const group = (groupId && SETTINGS_GROUP_BY_ID.get(groupId)) || SETTINGS_GROUPS[0]
  const tabId = match?.params.tab as SettingsTab | undefined
  const tab = tabId && group.tabs.some((item) => item.id === tabId) ? tabId : group.defaultTab
  return { group, tab }
}

export function settingsPath(group: SettingsGroup, tab?: SettingsTab): string {
  if (group === 'network' && tab === 'mode') return settingsPath('storage', 'mode')
  if (group === 'models' && tab === 'advanced') return settingsPath('models', 'providers')
  const config = SETTINGS_GROUP_BY_ID.get(group) ?? SETTINGS_GROUPS[0]
  return generatePath(ROUTE_PATH.settingsGroup, {
    group: config.id,
    tab: tab ?? config.defaultTab
  })
}

/** Usage drafts remain mounted while files are installed or providers are configured. */
export function preservesModelUsageDraft(pathname: string): boolean {
  return /^\/settings\/models\/(usage|providers|local|advanced)$/.test(pathname)
}

export type ModelUsageSection = 'ai-subtitles' | 'text-translation'
export function localModelFilesLocation(search: string, model: string, variant: string, section: ModelUsageSection) {
  const query = new URLSearchParams(search)
  query.set('model', model); query.set('variant', variant); query.set('usage', section)
  return { pathname: settingsPath('models', 'local'), search: `?${query}`, hash: '' }
}
export function modelUsageLocation(search: string, fallback: ModelUsageSection = 'ai-subtitles') {
  const query = new URLSearchParams(search)
  const section = query.get('usage') === 'text-translation' ? 'text-translation' : query.get('usage') === 'ai-subtitles' ? 'ai-subtitles' : fallback
  query.delete('model'); query.delete('variant'); query.delete('usage')
  return { pathname: settingsPath('models', 'usage'), search: query.toString() ? `?${query}` : '', hash: `#${section}` }
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
