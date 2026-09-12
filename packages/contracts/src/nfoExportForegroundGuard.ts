export interface NfoExportShortcutInput {
  key: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}

/** Navigation/application shortcuts that must not dismiss a foreground export surface. */
export function shouldBlockNfoExportShortcut(input: NfoExportShortcutInput): boolean {
  const key = input.key.toLowerCase()
  if (key === 'f5') return true
  if (input.altKey && (key === 'arrowleft' || key === 'arrowright')) return true
  if (!(input.ctrlKey || input.metaKey)) return false
  return ['r', 'w', 'k', '[', ']', 'arrowleft', 'arrowright'].includes(key)
}
