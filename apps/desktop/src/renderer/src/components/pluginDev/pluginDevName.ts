/** Suggest a non-colliding custom name when forking a built-in plugin for debugging. */
export function suggestForkedPluginName(baseName: string, takenNames: Iterable<string>): string {
  const taken = new Set(
    [...takenNames].map((name) => name.trim().toLowerCase()).filter(Boolean)
  )
  const base = baseName.trim() || 'plugin'
  const candidates = [`${base}-custom`, `${base} 自定义`, `${base}-fork`]
  for (const candidate of candidates) {
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  let index = 2
  while (taken.has(`${base}-custom-${index}`.toLowerCase())) index += 1
  return `${base}-custom-${index}`
}
