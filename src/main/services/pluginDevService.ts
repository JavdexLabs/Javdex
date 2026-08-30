import type {
  PluginDevAgentInput,
  PluginDevDryRunInput,
  PluginDevDryRunResult,
  PluginDevInstallInput,
  PluginDevRunTarget
} from '@shared/pluginDevTypes'
import type { ScraperPluginKind, ScraperPluginPackage } from '@shared/scraperPluginTypes'
import type { ActressScrapeField, ActressScrapeResult } from '@shared/actressScrapeTypes'
import type { ScrapeResult, VideoScrapeField } from '@shared/videoScrapeTypes'
import { resolveScrapeProxyUrl } from '@shared/settingsTypes'
import {
  installScraperPluginPackage,
  normalizeSupportedFields as normalizeInstalledSupportedFields
} from '../scrapers/scraperPluginService'
import {
  runUserActressPluginWithLogs,
  runUserVideoPluginWithLogs,
  validateUserPluginCode
} from '../scrapers/scraperPluginSandbox'
import {
  normalizeActressScrapeResult,
  normalizeVideoScrapeCandidates
} from '../scrapers/scraperResultValidation'
import { getSettings } from '../settings/settingsStore'
import {
  getPluginDevKindProfile,
  normalizeTestTargets
} from '@shared/pluginDevKindProfile'
import { normalizePluginCodeExport } from './pluginDevCodeEdit'

export const PLUGIN_UNMATCHED_TARGET_ERROR = '插件未找到精确匹配目标'
export const PLUGIN_INVALID_RESULT_ERROR = '插件返回结果格式无效'

function isContractEmptyResult(result: unknown): boolean {
  return result == null || (Array.isArray(result) && result.length === 0)
}
import { normalizeVideoCode } from '@shared/videoCode'
import { fieldSemanticsForKind } from '@shared/pluginFieldSemantics'
import { scrapeBrowser } from '../scrapers/scrapeBrowser'
import { projectVideoScrapeResult } from '../scrapers/videoScrapeFieldProjection'
import { projectActressScrapeResult } from '../scrapers/actressScrapeFieldProjection'
import { pluginResultContract } from '@shared/pluginResultContract'

export {
  replacePluginFunctionCode,
  replacePluginSnippetCode,
  listTopLevelFunctions
} from './pluginDevCodeEdit'
export type { TopLevelFunctionInfo } from './pluginDevCodeEdit'

function legacyRunTarget(input: PluginDevDryRunInput): PluginDevRunTarget | undefined {
  if (input.runTarget) return input.runTarget
  const target =
    (typeof input.testTarget === 'string' ? input.testTarget.trim() : '') ||
    normalizeTestTargets(input)[0]
  if (!target) return undefined
  return input.package.kind === 'video'
    ? { kind: 'video', code: target }
    : { kind: 'actress', mainName: target, aliases: [] }
}

function projectEffectiveObject(
  pkg: ScraperPluginPackage,
  value: Record<string, unknown>
): Record<string, unknown> {
  if (pkg.kind === 'video') {
    return projectVideoScrapeResult(
      value as unknown as ScrapeResult,
      new Set(normalizeInstalledSupportedFields('video', pkg.supportedFields) as VideoScrapeField[])
    ) as unknown as Record<string, unknown>
  }
  return projectActressScrapeResult(
    value as unknown as ActressScrapeResult,
    new Set(normalizeInstalledSupportedFields('actress', pkg.supportedFields) as ActressScrapeField[])
  ) as Record<string, unknown>
}

function projectEffectiveResult(
  pkg: ScraperPluginPackage,
  result: PluginDevDryRunResult['result']
): PluginDevDryRunResult['result'] {
  if (Array.isArray(result)) {
    return result.map((item) => projectEffectiveObject(pkg, item as unknown as Record<string, unknown>)) as PluginDevDryRunResult['result']
  }
  if (!result || typeof result !== 'object') return result
  return projectEffectiveObject(pkg, result as unknown as Record<string, unknown>) as PluginDevDryRunResult['result']
}

export async function dryRunPluginPackage(
  input: PluginDevDryRunInput,
  options: { signal?: AbortSignal } = {}
): Promise<PluginDevDryRunResult> {
  const pkg = normalizePackageForDev(input.package)
  const profile = getPluginDevKindProfile(pkg.kind)
  const runTarget = legacyRunTarget({ ...input, package: pkg })
  const testTarget = runTarget
    ? runTarget.kind === 'video' ? runTarget.code : runTarget.mainName
    : ''

  try {
    options.signal?.throwIfAborted()
    await validateUserPluginCode(pkg.kind, pkg.name, pkg.code, options.signal)
    const settings = getSettings()
    const proxyUrl = resolveScrapeProxyUrl(settings)

    if (pkg.kind === 'video') {
      if (runTarget?.kind !== 'video') throw new Error('影片 dry-run 缺少 video 运行目标')
      if (!testTarget) throw new Error(`请填写${profile.testTargetShortLabel}`)
      const raw = await runUserVideoPluginWithLogs(
        pkg.name,
        pkg.code,
        runTarget.code,
        proxyUrl,
        options.signal
      )
      const unrecognizedResultKeys = pluginResultContract.unrecognizedResultKeys(pkg.kind, raw.result)
      const expectedCode = normalizeVideoCode(runTarget.code)
      const normalizedCandidates = normalizeVideoScrapeCandidates(raw.result, expectedCode)
      const rejectedCodes: string[] = []
      const candidates = normalizedCandidates.filter((candidate) => {
        try {
          const matches = normalizeVideoCode(candidate.code) === expectedCode
          if (!matches) rejectedCodes.push(candidate.code)
          return matches
        } catch {
          rejectedCodes.push(String(candidate.code ?? '无效番号'))
          return false
        }
      })
      const pluginResult = Array.isArray(raw.result)
        ? normalizedCandidates
        : normalizedCandidates[0] ?? null
      const acceptedResult = Array.isArray(raw.result) ? candidates : candidates[0] ?? null
      const effectiveResult = projectEffectiveResult(pkg, acceptedResult)
      const { manifestCoverage } = pluginResultContract.analyze({
        kind: pkg.kind,
        pluginResult: acceptedResult,
        effectiveResult,
        declaredFields: pkg.supportedFields ?? []
      })
      return {
        ok: candidates.length > 0,
        result: effectiveResult,
        pluginResult,
        effectiveResult,
        manifestCoverage,
        unrecognizedResultKeys,
        logs: rejectedCodes.length > 0
          ? [...raw.logs, `已排除与测试番号 ${expectedCode} 不匹配的候选：${rejectedCodes.join(', ')}`]
          : raw.logs,
        error: candidates.length > 0
          ? undefined
          : rejectedCodes.length > 0
            ? `插件返回的候选番号与测试番号 ${expectedCode} 不匹配`
            : isContractEmptyResult(raw.result)
              ? PLUGIN_UNMATCHED_TARGET_ERROR
              : PLUGIN_INVALID_RESULT_ERROR,
        targets: [runTarget.code]
      }
    }

    if (runTarget?.kind !== 'actress') throw new Error('演员 dry-run 缺少 actress 运行目标')
    if (!testTarget) throw new Error(`请填写${profile.testTargetShortLabel}`)
    const raw = await runUserActressPluginWithLogs(
      pkg.name,
      pkg.code,
      runTarget.mainName,
      runTarget.aliases,
      proxyUrl,
      options.signal
    )
    const unrecognizedResultKeys = pluginResultContract.unrecognizedResultKeys(pkg.kind, raw.result)
    const pluginResult = normalizeActressScrapeResult(raw.result)
    const effectiveResult = projectEffectiveResult(pkg, pluginResult)
    const { manifestCoverage } = pluginResultContract.analyze({
      kind: pkg.kind,
      pluginResult,
      effectiveResult,
      declaredFields: pkg.supportedFields ?? []
    })
    return {
      ok: Boolean(pluginResult),
      result: effectiveResult,
      pluginResult,
      effectiveResult,
      manifestCoverage,
      unrecognizedResultKeys,
      logs: raw.logs,
      error: !pluginResult
        ? isContractEmptyResult(raw.result)
          ? PLUGIN_UNMATCHED_TARGET_ERROR
          : PLUGIN_INVALID_RESULT_ERROR
        : undefined,
      targets: [runTarget.mainName]
    }
  } catch (err) {
    if (options.signal?.aborted) throw err
    const logs = Array.isArray((err as { logs?: unknown }).logs)
      ? ((err as { logs: string[] }).logs ?? [])
      : []
    return {
      ok: false,
      result: null,
      logs,
      error: err instanceof Error ? err.message : String(err),
      targets: testTarget ? [testTarget] : []
    }
  } finally {
    // Explicit Agent/user-visible owners use AsyncLocal lease context, so this only
    // releases a lazily-created compatibility lease for standalone dry-run callers.
    scrapeBrowser.close()
  }
}

export async function installDevPluginPackage(input: PluginDevInstallInput) {
  return installScraperPluginPackage(input.package, {
    overwriteUser: input.overwriteUser ?? false
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
  if (fields !== undefined && !Array.isArray(fields)) {
    throw new Error('plugin.json.supportedFields 必须是字段 id 数组')
  }
  const allowed = new Set(getPluginDevKindProfile(kind).allSupportedFields)
  const resultKeyMappings = new Map<string, string[]>()
  for (const definition of fieldSemanticsForKind(kind)) {
    for (const resultKey of definition.resultKeys) {
      const mapped = resultKeyMappings.get(resultKey) ?? []
      if (!mapped.includes(definition.id)) mapped.push(definition.id)
      resultKeyMappings.set(resultKey, mapped)
    }
  }
  const out: ScraperPluginPackage['supportedFields'] = []
  const invalid: string[] = []
  for (const rawField of fields ?? []) {
    const field = typeof rawField === 'string' ? rawField.trim() : String(rawField)
    if (allowed.has(field as never)) {
      if (!out.includes(field as never)) out.push(field as never)
      continue
    }
    const mappedFields = resultKeyMappings.get(field)
    invalid.push(mappedFields?.length
      ? `${field} → ${mappedFields.join(' / ')}`
      : `${field}（无对应字段 id）`)
  }
  if (invalid.length > 0) {
    throw new Error(
      `plugin.json.supportedFields 包含无效字段 id：${invalid.join('，')}。` +
      'supportedFields 必须使用字段语义表中的字段 id，而不是 parse 返回键。'
    )
  }
  // Omitted is the legacy "all fields" form. An explicit empty array is a
  // valid development draft and must remain empty until discovery completes.
  return fields === undefined ? [...allowed] : out
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
