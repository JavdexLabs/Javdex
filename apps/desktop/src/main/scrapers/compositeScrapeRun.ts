/**
 * Shared composite scrape-run helpers for video / actress hosts.
 * Domain pick/merge/normalize stay in each manager; this module owns
 * registry merge and field-group orchestration.
 */

export function buildPluginRegistry<T extends { scraperName: string }>(
  loadUser: () => Iterable<T>,
  loadBundled: () => Iterable<T>
): Map<string, T> {
  const registry = new Map<string, T>()
  for (const scraper of loadUser()) {
    registry.set(scraper.scraperName, scraper)
  }
  for (const scraper of loadBundled()) {
    if (!registry.has(scraper.scraperName)) {
      registry.set(scraper.scraperName, scraper)
    }
  }
  return registry
}

export type CompositePluginErrorPolicy = 'abort' | 'collect'

export interface RunCompositeFieldGroupsInput<TField extends string, TResult> {
  fieldPluginMap: Partial<Record<TField, string | undefined>>
  fields: readonly TField[]
  runPlugin: (pluginName: string, fields: TField[]) => Promise<TResult | null>
  pick: (result: TResult, fields: TField[]) => TResult
  merge: (base: TResult | null, next: TResult) => TResult
  /**
   * `abort` — plugin errors propagate (video).
   * `collect` — per-plugin catch → warning; throw only if every grouped source threw (actress).
   */
  onPluginError: CompositePluginErrorPolicy
  formatPluginError?: (pluginName: string, error: Error) => string
}

export interface RunCompositeFieldGroupsOutcome<TField extends string, TResult> {
  result: TResult | null
  warnings: string[]
  matchedFields: TField[]
}

export async function runCompositeFieldGroups<TField extends string, TResult>(
  input: RunCompositeFieldGroupsInput<TField, TResult>
): Promise<RunCompositeFieldGroupsOutcome<TField, TResult>> {
  const grouped = new Map<string, TField[]>()
  for (const field of input.fields) {
    const pluginName = input.fieldPluginMap[field]
    if (!pluginName) continue
    grouped.set(pluginName, [...(grouped.get(pluginName) ?? []), field])
  }

  let merged: TResult | null = null
  let failedSources = 0
  const warnings: string[] = []
  const matchedFields: TField[] = []
  const formatError =
    input.formatPluginError ??
    ((pluginName: string, error: Error) => `字段源「${pluginName}」失败：${error.message}`)

  for (const [pluginName, pluginFields] of grouped) {
    try {
      const result = await input.runPlugin(pluginName, pluginFields)
      if (!result) continue
      merged = input.merge(merged, input.pick(result, pluginFields))
      matchedFields.push(...pluginFields)
    } catch (error) {
      if (input.onPluginError === 'abort') throw error
      failedSources += 1
      warnings.push(formatError(pluginName, error as Error))
    }
  }

  if (
    input.onPluginError === 'collect' &&
    grouped.size > 0 &&
    failedSources === grouped.size
  ) {
    throw new Error(warnings.join('；'))
  }

  return { result: merged, warnings, matchedFields }
}
