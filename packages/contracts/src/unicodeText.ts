const REPLACEMENT_CHARACTER = '\uFFFD'

/** Replace isolated UTF-16 surrogate code units while preserving valid pairs. */
export function sanitizeUnicodeScalars(value: string): string {
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index)
    if (current >= 0xD800 && current <= 0xDBFF) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        output += value[index] + value[index + 1]
        index += 1
      } else {
        output += REPLACEMENT_CHARACTER
      }
      continue
    }
    output += current >= 0xDC00 && current <= 0xDFFF ? REPLACEMENT_CHARACTER : value[index]
  }
  return output
}

/** Truncate by Unicode code points so an emoji/supplementary character is never split. */
export function truncateUnicode(value: string, maxCodePoints: number, suffix = ''): string {
  const safe = sanitizeUnicodeScalars(value)
  const limit = Math.max(0, Math.round(maxCodePoints))
  const points = Array.from(safe)
  if (points.length <= limit) return safe
  const suffixPoints = Array.from(sanitizeUnicodeScalars(suffix))
  const bodyLimit = Math.max(0, limit - suffixPoints.length)
  return `${points.slice(0, bodyLimit).join('')}${suffixPoints.slice(0, limit).join('')}`
}
