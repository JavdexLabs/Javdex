function aliasKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '')
}

/** Move an alias into the main-name field and keep the previous main name as an alias. */
export function promoteAliasToMain(
  mainName: string,
  aliases: readonly string[],
  alias: string
): { mainName: string; aliases: string[] } {
  const nextMain = alias.trim()
  if (!nextMain) return { mainName, aliases: [...aliases] }
  const prevMain = mainName.trim()
  let nextAliases = aliases.filter((item) => aliasKey(item) !== aliasKey(nextMain))
  if (prevMain && aliasKey(prevMain) !== aliasKey(nextMain)) {
    if (!nextAliases.some((item) => aliasKey(item) === aliasKey(prevMain))) {
      nextAliases = [...nextAliases, prevMain]
    }
  }
  return { mainName: nextMain, aliases: nextAliases }
}
