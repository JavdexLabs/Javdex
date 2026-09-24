/** Normalize scraped or manual cup input to a single uppercase letter (A–Z). */
export function normalizeCupSize(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed || /n\/a|未知/i.test(trimmed)) return null
  const match = trimmed.match(/([A-Za-z])/)
  return match ? match[1].toUpperCase() : null
}

/** Format stored cup letter for display, e.g. `D` → `D Cup`. */
export function formatCupSizeDisplay(value: string | null | undefined): string {
  const letter = normalizeCupSize(value)
  return letter ? `${letter} Cup` : '—'
}
