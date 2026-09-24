/** Parse an untrusted route/query id without accepting decimals or exponent notation. */
export function parsePositiveRouteId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** Validate a caller-owned id and return the canonical path/query representation. */
export function formatPositiveRouteId(value: number, label = 'id'): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} 必须是正安全整数`)
  }
  return String(value)
}
