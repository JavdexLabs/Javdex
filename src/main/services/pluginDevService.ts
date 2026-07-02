import {
  type PluginDevAgentInput,
  type PluginDevDryRunInput,
  type PluginDevDryRunResult,
  type PluginDevInstallInput,
  type ScraperPluginKind,
  type ScraperPluginPackage,
  resolveScrapeProxyUrl
} from '@shared/types'
import { installScraperPluginPackage } from '../scrapers/scraperPluginService'
import {
  runUserActressPluginWithLogs,
  runUserVideoPluginWithLogs,
  validateUserPluginCode
} from '../scrapers/scraperPluginSandbox'
import {
  normalizeActressScrapeResult,
  normalizeVideoScrapeResult
} from '../scrapers/scraperResultValidation'
import { getSettings } from '../settings/settingsStore'
import {
  getPluginDevKindProfile,
  normalizeTestTargets
} from '@shared/pluginDevKindProfile'
import { normalizePluginCodeExport } from './pluginDevCodeEdit'

export {
  replacePluginFunctionCode,
  replacePluginSnippetCode,
  listTopLevelFunctions
} from './pluginDevCodeEdit'
export type { TopLevelFunctionInfo } from './pluginDevCodeEdit'

export async function dryRunPluginPackage(
  input: PluginDevDryRunInput
): Promise<PluginDevDryRunResult> {
  const pkg = normalizePackageForDev(input.package)
  const profile = getPluginDevKindProfile(pkg.kind)
  const testTarget =
    (typeof input.testTarget === 'string' ? input.testTarget.trim() : '') ||
    normalizeTestTargets(input)[0]

  try {
    await validateUserPluginCode(pkg.kind, pkg.name, pkg.code)
    const settings = getSettings()
    const proxyUrl = resolveScrapeProxyUrl(settings)

    if (pkg.kind === 'video') {
      if (!testTarget) throw new Error(`请填写${profile.testTargetShortLabel}`)
      const raw = await runUserVideoPluginWithLogs(pkg.name, pkg.code, testTarget, proxyUrl)
      const result = normalizeVideoScrapeResult(raw.result, testTarget)
      return {
        ok: result !== null,
        result,
        logs: raw.logs,
        error: result ? undefined : '插件返回为空或结果格式无效'
      }
    }

    if (!testTarget) throw new Error(`请填写${profile.testTargetShortLabel}`)
    const raw = await runUserActressPluginWithLogs(
      pkg.name,
      pkg.code,
      testTarget,
      [],
      proxyUrl
    )
    const result = normalizeActressScrapeResult(raw.result)
    return {
      ok: result !== null,
      result,
      logs: raw.logs,
      error: result ? undefined : '插件返回为空或结果格式无效'
    }
  } catch (err) {
    const logs = Array.isArray((err as { logs?: unknown }).logs)
      ? ((err as { logs: string[] }).logs ?? [])
      : []
    return {
      ok: false,
      result: null,
      logs,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

export async function installDevPluginPackage(input: PluginDevInstallInput) {
  return installScraperPluginPackage(input.package, {
    overwriteUser: input.overwriteUser ?? true
  })
}

export function normalizePackageForDev(value: unknown): ScraperPluginPackage {
  if (!value || typeof value !== 'object') throw new Error('缺少插件包 package')
  const input = value as Partial<ScraperPluginPackage>
  if (input.schemaVersion !== 1) throw new Error('插件包 schemaVersion 必须为 1')
  if (input.kind !== 'video' && input.kind !== 'actress') {
    throw new Error('插件包 kind 必须为 video 或 actress')
  }
  if (!input.name?.trim()) throw new Error('插件包缺少 name')
  if (!input.code?.trim()) throw new Error('插件包缺少 code')
  return {
    schemaVersion: 1,
    kind: input.kind,
    name: input.name.trim(),
    version: input.version?.trim() || '1.0.0',
    description: input.description?.trim() || '',
    author: input.author?.trim() || undefined,
    homepage: input.homepage?.trim() || undefined,
    supportedFields: normalizeSupportedFields(input.kind, input.supportedFields),
    code: normalizePluginCodeExport(input.kind, input.code)
  }
}

function normalizeSupportedFields(
  kind: ScraperPluginKind,
  fields: ScraperPluginPackage['supportedFields']
): ScraperPluginPackage['supportedFields'] {
  const allowed = new Set(getPluginDevKindProfile(kind).allSupportedFields)
  const out: ScraperPluginPackage['supportedFields'] = []
  for (const field of fields ?? []) {
    if (allowed.has(field as never) && !out.includes(field)) out.push(field)
  }
  return out.length > 0 ? out : [...allowed]
}

export function toDryRunInput(
  input: PluginDevAgentInput,
  pkg: ScraperPluginPackage
): PluginDevDryRunInput {
  const testTargets = normalizeTestTargets(input)
  return {
    package: pkg,
    testTargets,
    testTarget: testTargets[0]
  }
}
