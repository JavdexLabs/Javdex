import { generatePath, matchPath } from 'react-router-dom'
import { ROUTE_PATH } from '../listView/routePaths'

export type SettingsGroup =
  | 'overview'
  | 'library'
  | 'plugins'
  | 'models'
  | 'appearance'
  | 'storage'
  | 'network'
  | 'about'

export type SettingsTab =
  | 'status'
  | 'paths'
  | 'video'
  | 'providers'
  | 'theme'
  | 'assets'
  | 'proxy'
  | 'info'

export interface SettingsTabItem {
  id: SettingsTab
  label: string
}

export interface SettingsGroupItem {
  id: SettingsGroup
  label: string
  hint: string
  description: string
  defaultTab: SettingsTab
  tabs: SettingsTabItem[]
}

export const SETTINGS_GROUPS: SettingsGroupItem[] = [
  {
    id: 'overview',
    label: '概览',
    hint: '关键状态',
    description: '库状态、默认配置与连接一览。',
    defaultTab: 'status',
    tabs: [{ id: 'status', label: '状态' }]
  },
  {
    id: 'library',
    label: '媒体库',
    hint: '路径与扫描',
    description: '管理扫描路径、导入影片与处理无法识别文件。',
    defaultTab: 'paths',
    tabs: [{ id: 'paths', label: '路径' }]
  },
  {
    id: 'plugins',
    label: '刮削插件',
    hint: '管理与默认来源',
    description: '管理刮削插件、设置默认来源与开发调试。',
    defaultTab: 'video',
    tabs: [{ id: 'video', label: '刮削插件' }]
  },
  {
    id: 'models',
    label: '模型',
    hint: 'LLM 供应商',
    description: '配置默认 LLM 与模型供应商。',
    defaultTab: 'providers',
    tabs: [{ id: 'providers', label: '模型' }]
  },
  {
    id: 'appearance',
    label: '外观',
    hint: '主题配色',
    description: '界面主题与配色，修改后立即生效。',
    defaultTab: 'theme',
    tabs: [{ id: 'theme', label: '主题' }]
  },
  {
    id: 'storage',
    label: '存储',
    hint: '资源路径',
    description: '媒体资源保存位置与图片加密设置。',
    defaultTab: 'assets',
    tabs: [{ id: 'assets', label: '存储' }]
  },
  {
    id: 'network',
    label: '网络',
    hint: '代理连接',
    description: '刮削与 LLM 请求的 HTTP/HTTPS 代理设置。',
    defaultTab: 'proxy',
    tabs: [{ id: 'proxy', label: '代理' }]
  },
  {
    id: 'about',
    label: '关于',
    hint: '版本与项目信息',
    description: '查看应用信息、版本更新、项目主页与开源许可。',
    defaultTab: 'info',
    tabs: [{ id: 'info', label: '关于 Javdex' }]
  }
]

export const SETTINGS_GROUP_BY_ID = new Map(SETTINGS_GROUPS.map((group) => [group.id, group]))

export function resolveSettingsRoute(pathname: string): { group: SettingsGroupItem; tab: SettingsTab } {
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
