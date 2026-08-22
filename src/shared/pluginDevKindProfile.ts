import {
  ACTRESS_SCRAPE_FIELD_OPTIONS,
  ALL_ACTRESS_SCRAPE_FIELDS,
  type ActressScrapeField
} from '@shared/actressScrapeTypes'
import type { PluginDevDryRunResult } from '@shared/pluginDevTypes'
import type { PluginDevRunTarget } from '@shared/pluginDevTypes'
import type { ScraperPluginKind } from '@shared/scraperPluginTypes'
import {
  ALL_VIDEO_SCRAPE_FIELDS,
  VIDEO_SCRAPE_FIELD_OPTIONS,
  type VideoScrapeField
} from '@shared/videoScrapeTypes'

export interface PluginDevKindProfile {
  kind: ScraperPluginKind
  parserName: 'parseVideo' | 'parseActress'
  testTargetLabel: string
  testTargetShortLabel: string
  siteUrlLabel: string
  defaultPluginNameSuffix: string
  allSupportedFields: readonly (VideoScrapeField | ActressScrapeField)[]
  fieldOptions: typeof VIDEO_SCRAPE_FIELD_OPTIONS | typeof ACTRESS_SCRAPE_FIELD_OPTIONS
  emptyPackageStub: string
  substantialCodePattern: RegExp
  aiDebugNeedsTargetMessage: string
  buildCodeModalPlaceholder: () => string
}

const VIDEO_PROFILE: PluginDevKindProfile = {
  kind: 'video',
  parserName: 'parseVideo',
  testTargetLabel: '测试番号',
  testTargetShortLabel: '番号',
  siteUrlLabel: '网站主页',
  defaultPluginNameSuffix: 'video-scraper',
  allSupportedFields: ALL_VIDEO_SCRAPE_FIELDS,
  fieldOptions: VIDEO_SCRAPE_FIELD_OPTIONS,
  emptyPackageStub: `async function parseVideo(ctx) {
  return null;
}

module.exports = { parseVideo };
`,
  substantialCodePattern:
    /\bfetchPage\b|\bctx\.browser\b|cheerio\.load|\$\(|parseDetail|searchUrl|buildDirect/i,
  aiDebugNeedsTargetMessage: 'AI调试需要至少填写一个测试番号',
  buildCodeModalPlaceholder: () =>
    'module.exports = { async parseVideo(ctx) { return null } }'
}

const ACTRESS_PROFILE: PluginDevKindProfile = {
  kind: 'actress',
  parserName: 'parseActress',
  testTargetLabel: '测试演员',
  testTargetShortLabel: '演员',
  siteUrlLabel: '网站主页',
  defaultPluginNameSuffix: 'actress-scraper',
  allSupportedFields: ALL_ACTRESS_SCRAPE_FIELDS,
  fieldOptions: ACTRESS_SCRAPE_FIELD_OPTIONS,
  emptyPackageStub: `async function parseActress(ctx) {
  return null;
}

module.exports = { parseActress };
`,
  substantialCodePattern:
    /\bfetchPage\b|\bctx\.browser\b|cheerio\.load|\$\(|parseProfile|searchUrl/i,
  aiDebugNeedsTargetMessage: 'AI调试需要至少填写一个测试演员',
  buildCodeModalPlaceholder: () =>
    'module.exports = { async parseActress(ctx) { return null } }'
}

const PROFILES: Record<ScraperPluginKind, PluginDevKindProfile> = {
  video: VIDEO_PROFILE,
  actress: ACTRESS_PROFILE
}

export function getPluginDevKindProfile(kind: ScraperPluginKind): PluginDevKindProfile {
  return PROFILES[kind]
}

export function parseTestTargetList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean)
  }
  if (typeof value !== 'string') return []
  return value
    .split(/[,，\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export interface PluginDevTestTargetInput {
  testTarget?: string
  testTargets?: string[] | unknown
}

export class PluginDevRunTargetInputError extends Error {
  readonly code = 'RUN_TARGET_INVALID' as const
}

function normalizedRuntimeIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new PluginDevRunTargetInputError(`${label}必须是字符串。`)
  }
  const normalized = value.normalize('NFKC').trim().replace(/\p{White_Space}+/gu, ' ')
  if (!normalized) throw new PluginDevRunTargetInputError(`${label}不能为空。`)
  if (normalized.length > 160) throw new PluginDevRunTargetInputError(`${label}长度不能超过 160 个字符。`)
  if (/\p{Cc}/u.test(normalized)) throw new PluginDevRunTargetInputError(`${label}不能包含控制字符。`)
  if (
    /^[a-z][a-z\d+.-]*:\/\//iu.test(normalized) ||
    /^(?:\.{0,2}[\\/]|[a-z]:[\\/])/iu.test(normalized) ||
    /[\\/]/u.test(normalized) ||
    /[?#][^\s]*=/u.test(normalized)
  ) {
    throw new PluginDevRunTargetInputError(`${label}必须是运行时身份，不能是 URL 或路径。`)
  }
  return normalized
}

function normalizedAliases(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new PluginDevRunTargetInputError('aliases 必须是字符串数组。')
  }
  if (value.length > 16) throw new PluginDevRunTargetInputError('aliases 最多包含 16 项。')
  const aliases = value.map((item) => normalizedRuntimeIdentity(item, '演员别名'))
  const seen = new Set<string>()
  return aliases.filter((alias) => {
    const key = alias.toLocaleLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function runTargetLabel(target: PluginDevRunTarget): string {
  return target.kind === 'video' ? target.code : target.mainName
}

export function normalizeRunTargets(targets: readonly PluginDevRunTarget[]): PluginDevRunTarget[] {
  if (targets.length > 8) throw new PluginDevRunTargetInputError('每次最多运行 8 个目标。')
  const normalized = targets.map((target): PluginDevRunTarget => {
    if (target.kind === 'video') {
      return {
        kind: 'video',
        code: normalizedRuntimeIdentity(target.code, '影片番号').toUpperCase()
      }
    }
    if (target.kind === 'actress') {
      return {
        kind: 'actress',
        mainName: normalizedRuntimeIdentity(target.mainName, '演员主名'),
        aliases: normalizedAliases(target.aliases)
      }
    }
    throw new PluginDevRunTargetInputError('运行目标 kind 无效。')
  })
  const seen = new Set<string>()
  return normalized.filter((target) => {
    const key = target.kind === 'video'
      ? `video:${target.code}`
      : `actress:${target.mainName.normalize('NFKC').replace(/\p{White_Space}+/gu, '').toLocaleLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function configuredRunTargets(
  kind: ScraperPluginKind,
  values: readonly string[]
): PluginDevRunTarget[] {
  return normalizeRunTargets(values.map((value) => kind === 'video'
    ? { kind: 'video', code: value }
    : { kind: 'actress', mainName: value, aliases: [] }))
}

export function resolveRunTargetsFromArgs(
  kind: ScraperPluginKind,
  args: Record<string, unknown>,
  fallback: readonly PluginDevRunTarget[]
): { targets: PluginDevRunTarget[]; explicit: boolean } {
  const hasVideoCodes = Object.hasOwn(args, 'videoCodes')
  const hasActresses = Object.hasOwn(args, 'actresses')
  if (kind === 'video' && hasActresses) {
    throw new PluginDevRunTargetInputError('影片插件只能使用 videoCodes，不能使用 actresses。')
  }
  if (kind === 'actress' && hasVideoCodes) {
    throw new PluginDevRunTargetInputError('演员插件只能使用 actresses，不能使用 videoCodes。')
  }
  let requested: PluginDevRunTarget[] = []
  if (kind === 'video' && hasVideoCodes) {
    if (!Array.isArray(args.videoCodes)) {
      throw new PluginDevRunTargetInputError('videoCodes 必须是字符串数组。')
    }
    requested = args.videoCodes.map((code) => {
      if (typeof code !== 'string') {
        throw new PluginDevRunTargetInputError('videoCodes 每项必须是字符串。')
      }
      return { kind: 'video' as const, code }
    })
  }
  if (kind === 'actress' && hasActresses) {
    if (!Array.isArray(args.actresses)) {
      throw new PluginDevRunTargetInputError('actresses 必须是对象数组。')
    }
    requested = args.actresses.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new PluginDevRunTargetInputError('actresses 每项必须包含 mainName。')
      }
      const row = item as Record<string, unknown>
      return {
        kind: 'actress' as const,
        mainName: normalizedRuntimeIdentity(row.mainName, '演员主名'),
        aliases: normalizedAliases(row.aliases)
      }
    })
  }
  const explicit = hasVideoCodes || hasActresses
  if (explicit && requested.length === 0) {
    throw new PluginDevRunTargetInputError('显式运行目标不能为空。')
  }
  return {
    targets: normalizeRunTargets(explicit ? requested : fallback),
    explicit
  }
}

/** Normalize a single target and a target list into stable insertion order. */
export function normalizeTestTargets(input: PluginDevTestTargetInput): string[] {
  const single = typeof input.testTarget === 'string' ? input.testTarget.trim() : ''
  const fromList = parseTestTargetList(input.testTargets)
  return [...new Set([...(single ? [single] : []), ...fromList].filter(Boolean))]
}

export function testTargetsFromDryRun(
  kind: ScraperPluginKind,
  dryRun: PluginDevDryRunResult | null | undefined
): string[] {
  if (!dryRun) return []
  const values: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) values.push(value.trim())
  }
  const pushResultIdentity = (result: unknown): void => {
    if (!result || typeof result !== 'object') return
    const record = result as Record<string, unknown>
    push(kind === 'video' ? record.code : record.mainName)
  }

  if (dryRun.cases?.length) {
    for (const item of dryRun.cases) {
      push(item.target)
      const results = Array.isArray(item.result) ? item.result : [item.result]
      for (const result of results) pushResultIdentity(result)
    }
  } else {
    const results = Array.isArray(dryRun.result) ? dryRun.result : [dryRun.result]
    for (const result of results) pushResultIdentity(result)
  }

  return [...new Set(values)]
}

export function fieldLabelForKind(kind: ScraperPluginKind, field: string): string {
  const profile = getPluginDevKindProfile(kind)
  return profile.fieldOptions.find((option) => option.id === field)?.label ?? field
}

export function allFieldIdsForKind(kind: ScraperPluginKind): string[] {
  return getPluginDevKindProfile(kind).fieldOptions.map((option) => option.id)
}

export function allFieldsForKind(
  kind: ScraperPluginKind
): Array<VideoScrapeField | ActressScrapeField> {
  return [...getPluginDevKindProfile(kind).allSupportedFields]
}

export function describeFieldsForKind(
  kind: ScraperPluginKind,
  fields: readonly (VideoScrapeField | ActressScrapeField)[]
): string {
  const profile = getPluginDevKindProfile(kind)
  return fields
    .map((field) => {
      const label = profile.fieldOptions.find((option) => option.id === field)?.label ?? field
      return `${field}(${label})`
    })
    .join(', ')
}
