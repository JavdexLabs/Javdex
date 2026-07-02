import type { ThemeId } from '@shared/types'
export { normalizeTheme } from '@shared/types'

export const THEME_OPTIONS: { id: ThemeId; label: string; hint: string }[] = [
  { id: 'graphite', label: '石墨', hint: '中性深灰，默认' },
  { id: 'warm', label: '暖灰', hint: '略偏暖的深色' },
  { id: 'slate', label: '青灰', hint: '略偏冷的深色' },
  { id: 'light', label: '浅色', hint: '适合白天' }
]

export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme
}
