import type { ThemeId } from '@shared/types'
export { normalizeTheme } from '@shared/types'

export const THEME_OPTIONS: { id: ThemeId; label: string; hint: string }[] = [
  { id: 'graphite', label: '石墨', hint: '中性深灰，默认' },
  { id: 'warm', label: '暖灰', hint: '柔和暖灰，低饱和' },
  { id: 'slate', label: '青灰', hint: '冷灰青色，低干扰' },
  { id: 'light', label: '浅色', hint: '清爽浅色，适合白天' }
]

export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme
}
