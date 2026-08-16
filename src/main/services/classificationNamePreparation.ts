import { normalizeClassificationName } from '@shared/classificationNameNormalization'

export interface PreparedClassificationNames {
  mainName: string
  aliases: string[]
  normalizedNames: Array<{
    name: string
    normalizedName: string
    type: 'main' | 'alias'
  }>
}

export function prepareClassificationNames(
  mainNameInput: string,
  aliasesInput: readonly string[]
): PreparedClassificationNames {
  const mainName = mainNameInput.trim()
  const mainNormalized = normalizeClassificationName(mainName)
  const normalizedNames: PreparedClassificationNames['normalizedNames'] = [
    { name: mainName, normalizedName: mainNormalized, type: 'main' }
  ]
  const seen = new Set([mainNormalized])
  const aliases: string[] = []
  for (const rawAlias of aliasesInput) {
    const alias = rawAlias.trim()
    if (!alias) continue
    const normalizedName = normalizeClassificationName(alias)
    if (seen.has(normalizedName)) continue
    seen.add(normalizedName)
    aliases.push(alias)
    normalizedNames.push({ name: alias, normalizedName, type: 'alias' })
  }
  return { mainName, aliases, normalizedNames }
}
