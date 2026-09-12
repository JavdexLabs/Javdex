/** Split a standard code like MUKD-501 into label + remainder (-501). */
export function splitVideoCode(code: string): { prefix: string; suffix: string } | null {
  const idx = code.indexOf('-')
  if (idx <= 0 || idx >= code.length - 1) return null
  return { prefix: code.slice(0, idx), suffix: code.slice(idx) }
}
