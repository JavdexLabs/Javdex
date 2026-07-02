import type {
  ActressScrapeField,
  PluginDevAgentMode,
  PluginDevDiscovery,
  PluginDevFieldVerification,
  PluginDevPageInsight,
  PluginDevVerificationReport,
  PluginDevVerificationStatus,
  PluginDevVerifyInput,
  ScraperPluginKind,
  VideoScrapeField
} from '@shared/types'
import {
  expandActressScrapeFields
} from '@shared/types'
import { requestAgentJson } from './agentJsonClient'
import { formatPageInsightForPrompt } from './pluginDevPageFormat'
import {
  describeFieldsForKind,
  getPluginDevKindProfile,
  normalizeTestTargets,
  pageMatchesActressTarget,
  pageMatchesReferenceTargetForKind
} from '@shared/pluginDevKindProfile'

export { pageMatchesActressTarget } from '@shared/pluginDevKindProfile'

export type {
  PluginDevFieldVerification,
  PluginDevVerificationReport,
  PluginDevVerificationStatus
}

export type PluginDevVerificationOptions = PluginDevVerifyInput

interface SemanticVerificationResponse {
  summary?: string
  items?: Array<{
    field?: string
    status?: string
    actual?: string
    expected?: string
    note?: string
  }>
}

const VIDEO_RESULT_KEYS = new Set([
  'code',
  'title',
  'summary',
  'coverUrl',
  'releaseDate',
  'maker',
  'publisher',
  'series',
  'director',
  'durationSeconds',
  'sourceUrl',
  'ratingAverage',
  'ratingCount',
  'sampleImageUrls',
  'actresses',
  'tags'
])

const ACTRESS_RESULT_KEYS = new Set([
  'mainName',
  'nameZh',
  'nameEn',
  'avatarUrl',
  'birthDate',
  'debutDate',
  'heightCm',
  'bustCm',
  'waistCm',
  'hipCm',
  'cupSize',
  'bloodType',
  'zodiac',
  'nationality',
  'profileSummary',
  'galleryImageUrls',
  'aliases',
  'sourceUrl'
])

/** Maps verification item / parse-result keys to selectable supported field ids. */
const VIDEO_VERIFICATION_TO_SUPPORTED_ID: Record<string, VideoScrapeField> = {
  title: 'title',
  summary: 'summary',
  coverUrl: 'cover',
  cover: 'cover',
  releaseDate: 'releaseDate',
  maker: 'maker',
  publisher: 'publisher',
  series: 'series',
  director: 'director',
  actresses: 'actressesFemale',
  actressesFemale: 'actressesFemale',
  actressesMale: 'actressesMale',
  tags: 'tags',
  sourceUrl: 'source',
  source: 'source',
  sampleImageUrls: 'samples',
  samples: 'samples',
  durationSeconds: 'duration',
  duration: 'duration',
  ratingAverage: 'rating',
  ratingCount: 'rating',
  rating: 'rating'
}

const ACTRESS_VERIFICATION_TO_SUPPORTED_ID: Record<string, ActressScrapeField> = {
  avatarUrl: 'avatar',
  avatar: 'avatar',
  galleryImageUrls: 'gallery',
  gallery: 'gallery',
  birthDate: 'birthDate',
  nameZh: 'nameZh',
  nameEn: 'nameEn',
  debutDate: 'debutDate',
  profileSummary: 'profileSummary',
  heightCm: 'heightCm',
  bustCm: 'measurements',
  waistCm: 'measurements',
  hipCm: 'measurements',
  measurements: 'measurements',
  cupSize: 'cupSize',
  bloodType: 'bloodType',
  zodiac: 'zodiac',
  nationality: 'nationality',
  aliases: 'aliases'
}

const VALID_STATUSES = new Set<PluginDevVerificationStatus>([
  'ok',
  'missing_in_result',
  'not_on_page',
  'suspicious',
  'invalid_key'
])

/** Page text/link signals that a supported field may exist on the reference page. */
const VIDEO_FIELD_PAGE_SIGNALS: Partial<
  Record<VideoScrapeField, { text?: RegExp[]; link?: RegExp[] }>
> = {
  series: { text: [/系列/i, /\bseries\b/i], link: [/\/series\//i] },
  director: { text: [/导演/i, /\bdirector\b/i], link: [/\/director\//i] },
  publisher: { text: [/发行商/i, /厂牌/i, /\blabel\b/i], link: [/\/label\//i] },
  maker: { text: [/制作商/i, /片商/i, /\bmaker\b/i, /\bstudio\b/i], link: [/\/studio\//i] },
  duration: { text: [/时长/i, /\bduration\b/i, /\d+\s*分(?:钟)?/i] },
  rating: { text: [/评分/i, /\brating\b/i, /星评/i] },
  releaseDate: { text: [/发行日期/i, /発売日/i, /\brelease(?:\s*date)?\b/i] },
  summary: { text: [/简介/i, /剧情/i, /描述/i, /\bsummary\b/i, /\bdescription\b/i] },
  actressesFemale: {
    text: [/女优/i, /女優/i, /演员/i, /\bactress(?:es)?\b/i, /\bcast\b/i, /\bstarring\b/i]
  },
  actressesMale: { text: [/男优/i, /男優/i, /\bmale\b/i, /\bactor\b/i] }
}

const VIDEO_RESULT_FIELD_KEYS: Partial<Record<VideoScrapeField, string[]>> = {
  title: ['title'],
  summary: ['summary'],
  cover: ['coverUrl'],
  releaseDate: ['releaseDate'],
  maker: ['maker'],
  publisher: ['publisher'],
  series: ['series'],
  director: ['director'],
  duration: ['durationSeconds'],
  actressesFemale: ['actresses'],
  actressesMale: ['actresses'],
  tags: ['tags'],
  source: ['sourceUrl'],
  rating: ['ratingAverage', 'ratingCount'],
  samples: ['sampleImageUrls']
}

const ACTRESS_RESULT_FIELD_KEYS: Partial<Record<ActressScrapeField, string[]>> = {
  avatar: ['avatarUrl'],
  gallery: ['galleryImageUrls'],
  birthDate: ['birthDate'],
  nameZh: ['nameZh'],
  nameEn: ['nameEn'],
  debutDate: ['debutDate'],
  heightCm: ['heightCm'],
  measurements: ['bustCm', 'waistCm', 'hipCm'],
  cupSize: ['cupSize'],
  bloodType: ['bloodType'],
  zodiac: ['zodiac'],
  nationality: ['nationality'],
  profileSummary: ['profileSummary'],
  aliases: ['aliases']
}

const ACTRESS_FIELD_PAGE_SIGNALS: Partial<
  Record<ActressScrapeField, { text?: RegExp[]; link?: RegExp[] }>
> = {
  avatar: { text: [/头像/i, /\bavatar\b/i, /\bphoto\b/i] },
  gallery: { text: [/写真/i, /图集/i, /\bgallery\b/i, /\bphotos?\b/i] },
  birthDate: { text: [/生日/i, /出生/i, /\bbirth(?:day|date)?\b/i, /年龄/i] },
  nameZh: { text: [/中文名/i, /Chinese name/i] },
  nameEn: { text: [/英文名/i, /English name/i] },
  debutDate: { text: [/出道/i, /\bdebut\b/i] },
  heightCm: { text: [/身高/i, /\bheight\b/i, /\d+\s*cm/i] },
  measurements: {
    text: [/三围/i, /胸围/i, /腰围/i, /臀围/i, /\bbust\b/i, /\bwaist\b/i, /\bhip\b/i]
  },
  cupSize: { text: [/罩杯/i, /\bcup\b/i] },
  bloodType: { text: [/血型/i, /\bblood type\b/i] },
  zodiac: { text: [/星座/i, /\bzodiac\b/i] },
  nationality: { text: [/国籍/i, /\bnationality\b/i] },
  profileSummary: { text: [/简介/i, /资料/i, /\bprofile\b/i, /个人简介/i, /本名/i] },
  aliases: { text: [/别名/i, /曾用名/i, /\balias/i, /其他名称/i] }
}

const PAGE_LACKS_FIELD_NOTE =
  /页面(无|没有|不包含|未展示|未提供|不存在|缺少)|站点无|无此字段|not\s+(present|available)\s+on|no\s+\w+\s+on\s+(the\s+)?page/i

const SITE_UNSUPPORTED_FIELD_NOTE =
  /站点无(?:此)?字段|站点不(?:支持|提供)|站点(?:详情|资料)页模板无|无男优字段|无此字段能力/i

export function normalizeVerificationItemField(field: string): string {
  const dot = field.indexOf('.')
  if (dot <= 0 || dot >= field.length - 1) return field
  return field.slice(dot + 1)
}

export function noteSuggestsSiteUnsupportedField(note?: string): boolean {
  return SITE_UNSUPPORTED_FIELD_NOTE.test(note ?? '')
}

function fieldHasPageSignals(
  kind: ScraperPluginKind,
  fieldId: VideoScrapeField | ActressScrapeField
): boolean {
  const signals =
    kind === 'video'
      ? VIDEO_FIELD_PAGE_SIGNALS[fieldId as VideoScrapeField]
      : ACTRESS_FIELD_PAGE_SIGNALS[fieldId as ActressScrapeField]
  return Boolean(signals?.text?.length || signals?.link?.length)
}

function detailTemplateLikely(page: PluginDevPageInsight, kind: ScraperPluginKind): boolean {
  const blob = `${page.title}\n${page.text}`
  if (kind === 'video') {
    const hasIdentity = /title|标题|番号|\b[A-Z]{2,6}-\d+\b/i.test(blob)
    const hasMetadata =
      /maker|studio|制作|片商|publisher|label|发行|厂牌|released|发行日期|発売/i.test(blob)
    return hasIdentity && hasMetadata && blob.trim().length > 60
  }
  const hasIdentity = /mainName|本名|中文名|英文名|profile|资料/i.test(blob) || blob.trim().length > 60
  const hasMetadata = /生日|出生|三围|身高|写真|gallery|profile|简介/i.test(blob)
  return hasIdentity && hasMetadata
}

/** Fields to remove from supportedFields when verify proves site-level absence. */
export function collectSiteUnsupportedSupportedFields(
  kind: ScraperPluginKind,
  supportedFields: readonly (VideoScrapeField | ActressScrapeField)[],
  verificationItems: readonly PluginDevFieldVerification[]
): Array<VideoScrapeField | ActressScrapeField> {
  const remove = new Set<VideoScrapeField | ActressScrapeField>()

  for (const fieldId of supportedFields) {
    const items = verificationItems.filter(
      (item) =>
        resolveVerificationSupportedFieldId(kind, normalizeVerificationItemField(item.field)) ===
        fieldId
    )
    if (items.length === 0) continue
    const siteUnsupported = items.every(
      (item) => item.status === 'ok' && noteSuggestsSiteUnsupportedField(item.note)
    )
    if (siteUnsupported) remove.add(fieldId)
  }

  return supportedFields.filter((field) => remove.has(field))
}

function noteSuggestsPageOnlyAbsence(note?: string): boolean {
  return /参考页面无此字段|页面无此字段/i.test(note ?? '')
}

function isKnownSupportedFieldId(
  kind: ScraperPluginKind,
  fieldId: string
): fieldId is VideoScrapeField | ActressScrapeField {
  return getPluginDevKindProfile(kind).allSupportedFields.includes(fieldId as never)
}

function dryRunResultsFromInput(lastResults?: unknown[]): Record<string, unknown>[] {
  return (lastResults ?? []).filter(
    (value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object'
  )
}

/** Fields to add when verify confirms site/plugin supports them but supportedFields omits them. */
export function collectSupportedFieldsToAdd(
  kind: ScraperPluginKind,
  supportedFields: readonly (VideoScrapeField | ActressScrapeField)[],
  verificationItems: readonly PluginDevFieldVerification[],
  lastResults?: unknown[]
): Array<VideoScrapeField | ActressScrapeField> {
  const supported = new Set(supportedFields)
  const toAdd = new Set<VideoScrapeField | ActressScrapeField>()
  const results = dryRunResultsFromInput(lastResults)

  for (const item of verificationItems) {
    if (item.status !== 'ok') continue
    if (noteSuggestsSiteUnsupportedField(item.note)) continue

    const fieldId = resolveVerificationSupportedFieldId(
      kind,
      normalizeVerificationItemField(item.field)
    )
    if (!isKnownSupportedFieldId(kind, fieldId)) continue
    if (supported.has(fieldId) || toAdd.has(fieldId)) continue

    const hasResultValue = results.some(
      (result) => !isEmptyFieldValue(getResultValueForField(kind, fieldId, result))
    )
    if (noteSuggestsPageOnlyAbsence(item.note) && !hasResultValue) continue

    if (hasResultValue || !noteSuggestsPageOnlyAbsence(item.note)) {
      toAdd.add(fieldId)
    }
  }

  for (const fieldId of getPluginDevKindProfile(kind).allSupportedFields) {
    if (supported.has(fieldId) || toAdd.has(fieldId)) continue
    const hasResultValue = results.some(
      (result) => !isEmptyFieldValue(getResultValueForField(kind, fieldId, result))
    )
    if (!hasResultValue) continue

    const items = verificationItems.filter(
      (item) =>
        resolveVerificationSupportedFieldId(kind, normalizeVerificationItemField(item.field)) ===
        fieldId
    )
    if (
      items.some(
        (item) => item.status === 'ok' && !noteSuggestsSiteUnsupportedField(item.note)
      )
    ) {
      toAdd.add(fieldId)
    }
  }

  return [...toAdd]
}

export interface SupportedFieldsSyncResult {
  supportedFields: Array<VideoScrapeField | ActressScrapeField>
  added: Array<VideoScrapeField | ActressScrapeField>
  removed: Array<VideoScrapeField | ActressScrapeField>
  changed: boolean
}

/** Sync supportedFields after plugin_verify; create mode adds+removes, debug/feedback adds only. */
export function syncSupportedFieldsFromVerification(options: {
  mode: PluginDevAgentMode
  kind: ScraperPluginKind
  supportedFields: readonly (VideoScrapeField | ActressScrapeField)[]
  verificationItems: readonly PluginDevFieldVerification[]
  lastResults?: unknown[]
}): SupportedFieldsSyncResult {
  const active = [...options.supportedFields]
  const added = collectSupportedFieldsToAdd(
    options.kind,
    active,
    options.verificationItems,
    options.lastResults
  )
  let next = [...active]
  for (const field of added) {
    if (!next.includes(field)) next.push(field)
  }

  let removed: Array<VideoScrapeField | ActressScrapeField> = []
  if (options.mode === 'create') {
    removed = collectSiteUnsupportedSupportedFields(
      options.kind,
      next,
      options.verificationItems
    )
    if (removed.length > 0) {
      next = next.filter((field) => !removed.includes(field))
    }
  }

  return {
    supportedFields: next,
    added,
    removed,
    changed: added.length > 0 || removed.length > 0
  }
}

export function resolveVerificationSupportedFieldId(
  kind: ScraperPluginKind,
  field: string
): VideoScrapeField | ActressScrapeField | string {
  if (kind === 'video') {
    return VIDEO_VERIFICATION_TO_SUPPORTED_ID[field] ?? field
  }
  return ACTRESS_VERIFICATION_TO_SUPPORTED_ID[field] ?? field
}

export function isVerificationFieldInSupportedScope(
  kind: ScraperPluginKind,
  field: string,
  supportedFields: readonly (VideoScrapeField | ActressScrapeField)[]
): boolean {
  const supported = new Set(
    kind === 'actress' ? expandActressScrapeFields(supportedFields) : supportedFields
  )
  if (kind === 'video' && (field === 'actresses' || field === 'actressesFemale' || field === 'actressesMale')) {
    return supported.has('actressesFemale') || supported.has('actressesMale')
  }
  const fieldId = resolveVerificationSupportedFieldId(kind, field)
  return supported.has(fieldId as VideoScrapeField & ActressScrapeField)
}

export function filterVerificationItemsBySupportedFields(
  items: PluginDevFieldVerification[],
  supportedFields: readonly (VideoScrapeField | ActressScrapeField)[],
  kind: ScraperPluginKind
): PluginDevFieldVerification[] {
  return items.filter((item) => {
    if (item.status === 'invalid_key') return true
    if (item.field === 'reference_page') return true
    return isVerificationFieldInSupportedScope(kind, item.field, supportedFields)
  })
}

export function isEmptyFieldValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

export function pageLikelyHasFieldSignal(
  kind: ScraperPluginKind,
  fieldId: VideoScrapeField | ActressScrapeField,
  page: PluginDevPageInsight
): boolean {
  const signals =
    kind === 'video'
      ? VIDEO_FIELD_PAGE_SIGNALS[fieldId as VideoScrapeField]
      : ACTRESS_FIELD_PAGE_SIGNALS[fieldId as ActressScrapeField]
  if (!signals) return true

  const textBlob = `${page.title}\n${page.text}`
  if (signals.text?.some((pattern) => pattern.test(textBlob))) return true
  if (signals.link?.some((pattern) => page.links.some((link) => pattern.test(link.href ?? '')))) {
    return true
  }
  return false
}

export function getResultValueForField(
  kind: ScraperPluginKind,
  fieldId: VideoScrapeField | ActressScrapeField,
  result: Record<string, unknown>
): unknown {
  const keys =
    kind === 'video'
      ? VIDEO_RESULT_FIELD_KEYS[fieldId as VideoScrapeField]
      : ACTRESS_RESULT_FIELD_KEYS[fieldId as ActressScrapeField]
  if (!keys?.length) return result[fieldId]
  for (const key of keys) {
    const value = result[key]
    if (!isEmptyFieldValue(value)) return value
  }
  return result[keys[0] ?? fieldId]
}

function getResultValueForVerificationItem(
  kind: ScraperPluginKind,
  field: string,
  fieldId: VideoScrapeField | ActressScrapeField,
  result: Record<string, unknown>
): unknown {
  const concreteKeys = kind === 'video' ? VIDEO_RESULT_KEYS : ACTRESS_RESULT_KEYS
  if (concreteKeys.has(field)) return result[field]
  return getResultValueForField(kind, fieldId, result)
}

function noteSuggestsPageLacksField(note: string | undefined): boolean {
  return Boolean(note && PAGE_LACKS_FIELD_NOTE.test(note))
}

function resolveVerifyTestTarget(options: PluginDevVerificationOptions): string {
  const single = typeof options.testTarget === 'string' ? options.testTarget.trim() : ''
  if (single) return single
  return normalizeTestTargets(options)[0] ?? ''
}

function buildReferencePageMismatchReport(
  kind: ScraperPluginKind,
  referencePage: PluginDevPageInsight,
  targetName: string
): PluginDevVerificationReport {
  const profile = getPluginDevKindProfile(kind)
  const pageTitle = referencePage.title?.trim() || referencePage.url || '未知页面'
  return {
    referencePage,
    items: [
      {
        field: 'reference_page',
        status: 'suspicious',
        note: `参考页「${pageTitle}」与测试${profile.testTargetShortLabel}「${targetName}」不匹配，已跳过字段语义对照。请让 ${profile.parserName} 返回 sourceUrl，或 browser_fetch_page 打开正确${profile.pageLabel}后再 verify。`
      }
    ],
    summary: `参考页与测试${profile.testTargetShortLabel}「${targetName}」不匹配，未做字段语义对照（避免误用其他${profile.pageLabel}否定正确结果）。`
  }
}

export function normalizeAbsentFieldVerifications(
  items: PluginDevFieldVerification[],
  options: Pick<PluginDevVerificationOptions, 'kind' | 'supportedFields' | 'lastResult'>,
  referencePage?: PluginDevPageInsight
): PluginDevFieldVerification[] {
  if (!referencePage || !options.lastResult || typeof options.lastResult !== 'object') return items
  const result = options.lastResult as Record<string, unknown>

  return items.map((item) => {
    if (item.status !== 'missing_in_result' && item.status !== 'not_on_page') return item
    if (item.status === 'not_on_page' && !isEmptyFieldValue(item.actual)) return item

    const fieldId = resolveVerificationSupportedFieldId(options.kind, item.field)
    if (
      !isVerificationFieldInSupportedScope(options.kind, item.field, options.supportedFields)
    ) {
      return item
    }

    const resultValue = getResultValueForVerificationItem(
      options.kind,
      item.field,
      fieldId as VideoScrapeField & ActressScrapeField,
      result
    )
    if (!isEmptyFieldValue(resultValue)) {
      return {
        ...item,
        status: 'ok',
        note: item.note ? `${item.note}；调试结果已包含该字段` : '调试结果已包含该字段'
      }
    }

    const pageHasField = pageLikelyHasFieldSignal(
      options.kind,
      fieldId as VideoScrapeField & ActressScrapeField,
      referencePage
    )
    const pageLacksField = !pageHasField || noteSuggestsPageLacksField(item.note)
    if (!pageLacksField) return item

    const templateLacksField =
      detailTemplateLikely(referencePage, options.kind) &&
      fieldHasPageSignals(
        options.kind,
        fieldId as VideoScrapeField & ActressScrapeField
      ) &&
      !pageHasField

    return {
      ...item,
      status: 'ok',
      note: item.note
        ? templateLacksField
          ? `${item.note}；站点详情页模板无此字段标签，插件留空正确`
          : `${item.note}；参考页面无此字段语义来源，插件留空正确`
        : templateLacksField
          ? '站点详情页模板无此字段标签，插件留空正确'
          : '参考页面无此字段语义来源，插件留空正确'
    }
  })
}

export function isBlockingVerificationFailure(item: PluginDevFieldVerification): boolean {
  return item.status !== 'ok'
}

function scopeVerificationReport(
  report: PluginDevVerificationReport,
  options: Pick<PluginDevVerificationOptions, 'supportedFields' | 'kind' | 'lastResult'>
): PluginDevVerificationReport {
  const scoped = filterVerificationItemsBySupportedFields(
    report.items,
    options.supportedFields,
    options.kind
  )
  const items = normalizeAbsentFieldVerifications(scoped, options, report.referencePage)
  const keepCustomSummary =
    Boolean(report.summary) &&
    items.some((item) => item.field === 'reference_page') &&
    report.items.some((item) => item.field === 'reference_page')
  return {
    ...report,
    items,
    summary: keepCustomSummary ? report.summary : summarizeVerification(items)
  }
}

export async function verifyDebugResultAgainstPages(
  options: PluginDevVerificationOptions
): Promise<PluginDevVerificationReport> {
  const referencePage = pickVerificationPage(options.discovery)
  const verifyTarget = resolveVerifyTestTarget(options)
  const structural = collectStructuralVerificationIssues(options.kind, options.lastResult)
  const linkTrap =
    options.kind === 'video'
      ? collectMakerPublisherLinkTrapIssues(options.lastResult, referencePage)
      : []

  if (
    referencePage &&
    verifyTarget &&
    !pageMatchesReferenceTargetForKind(
      options.kind,
      referencePage,
      verifyTarget,
      options.lastResult
    )
  ) {
    return scopeVerificationReport(
      buildReferencePageMismatchReport(options.kind, referencePage, verifyTarget),
      options
    )
  }

  if (!referencePage || !options.lastResult || typeof options.lastResult !== 'object') {
    const userItems = buildUserFeedbackVerificationItems(options.userFeedback)
    const items = mergeVerificationItems(structural, linkTrap, userItems)
    return scopeVerificationReport(
      {
        referencePage,
        items,
        summary: buildFallbackSummary(referencePage, options.userFeedback, items)
      },
      options
    )
  }

  try {
    const semantic = await requestSemanticVerification(options, referencePage)
    const items = mergeVerificationItems(structural, linkTrap, semantic.items)
    return scopeVerificationReport(
      {
        referencePage,
        items,
        summary: semantic.summary || summarizeVerification(items)
      },
      options
    )
  } catch (err) {
    const userItems = buildUserFeedbackVerificationItems(options.userFeedback)
    const items = mergeVerificationItems(structural, linkTrap, userItems)
    const errorNote = err instanceof Error ? err.message : String(err)
    return scopeVerificationReport(
      {
        referencePage,
        items,
        summary:
          items.length > 0
            ? `${summarizeVerification(items)}；语义验证未完成：${errorNote}`
            : `语义验证未完成：${errorNote}`
      },
      options
    )
  }
}

export function collectStructuralVerificationIssues(
  kind: ScraperPluginKind,
  lastResult: unknown
): PluginDevFieldVerification[] {
  if (!lastResult || typeof lastResult !== 'object') return []
  const result = lastResult as Record<string, unknown>
  const allowed = kind === 'video' ? VIDEO_RESULT_KEYS : ACTRESS_RESULT_KEYS
  const items: PluginDevFieldVerification[] = []

  for (const key of Object.keys(result)) {
    if (allowed.has(key)) continue
    items.push({
      field: key,
      status: 'invalid_key',
      actual: stringifyValue(result[key]),
      note: '字段名不在 parse 返回规范中'
    })
  }

  return items
}

export function collectMakerPublisherLinkTrapIssues(
  lastResult: unknown,
  referencePage?: PluginDevPageInsight
): PluginDevFieldVerification[] {
  if (!referencePage || !lastResult || typeof lastResult !== 'object') return []
  const result = lastResult as Record<string, unknown>
  const maker = readText(result.maker)
  const publisher = readText(result.publisher)
  if (!maker && !publisher) return []

  const studioTexts = uniqueLinkTexts(
    referencePage.links.filter((link) => /\/studio\//i.test(link.href ?? ''))
  )
  const labelTexts = uniqueLinkTexts(
    referencePage.links.filter((link) => /\/label\//i.test(link.href ?? ''))
  )
  const items: PluginDevFieldVerification[] = []

  if (studioTexts.length >= 2 && maker) {
    const breadcrumbText = studioTexts[0]
    const metadataText = studioTexts[studioTexts.length - 1]
    if (maker === breadcrumbText && breadcrumbText !== metadataText) {
      items.push({
        field: 'maker',
        status: 'suspicious',
        actual: maker,
        pageHint: metadataText,
        note: `页面存在多个 /studio/ 链接且锚文本不同（${studioTexts.join(' / ')}）；当前值疑似取自导航/面包屑首个匹配，应改为在元数据区按「片商」标签旁的 dt a 提取，或排除 .breadcrumb。`
      })
    }
  }

  if (labelTexts.length >= 2 && publisher) {
    const breadcrumbText = labelTexts[0]
    const metadataText = labelTexts[labelTexts.length - 1]
    if (publisher === breadcrumbText && breadcrumbText !== metadataText) {
      items.push({
        field: 'publisher',
        status: 'suspicious',
        actual: publisher,
        pageHint: metadataText,
        note: `页面存在多个 /label/ 链接且锚文本不同（${labelTexts.join(' / ')}）；当前值疑似取自导航/面包屑首个匹配或番号前缀，应改为在元数据区按「厂牌」标签旁的 dt a 提取，或排除 .breadcrumb。`
      })
    }
  }

  return items
}

function uniqueLinkTexts(links: Array<{ text?: string }>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const link of links) {
    const text = link.text?.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

export function buildSemanticVerificationPrompt(
  options: PluginDevVerificationOptions,
  referencePage: PluginDevPageInsight
): string {
  const profile = getPluginDevKindProfile(options.kind)
  const verifyTarget = resolveVerifyTestTarget(options) || '未提供'
  const selectedFields = describeFieldsForKind(options.kind, options.supportedFields)

  return `请作为刮削插件调试审核员，只做语义验证，不要生成或修改插件代码。

任务：判断“上次调试结果”中的各字段值，是否与其语义含义及参考页面实际内容一致。

插件类型：${profile.kindLabel}
测试目标：${verifyTarget}${profile.buildVerifyReferenceHint()}
需要支持的字段：${selectedFields || '无'}

用户反馈（最高优先级，若指出某字段错误，必须优先按用户语义判断，不能因字符串出现在页面就判为正确）：
${options.userFeedback?.trim() || '无'}

字段语义说明：
${profile.buildReturnGlossary()}

${profile.buildSupportedFieldsSection()}

上次调试结果：
${stringifyForPrompt(options.lastResult)}

参考页面结构：
${formatReferencePage(referencePage)}

验证规则：
1. 按字段语义判断，不要把“字符串出现在页面某处”等同于“字段正确”${profile.semanticFieldMismatchExample}。
2. 若页面是${profile.kindLabel}${profile.pageLabel}，优先以${profile.pageLabel}中的真实来源判断；若插件明显只解析了搜索页，应判为 suspicious 或 missing_in_result。
3. 用户反馈明确指出的字段，除非调试结果已按反馈语义修正，否则不得标为 ok。
4. 只验证 supportedFields 相关字段，以及调试结果里出现的明显无效字段名。
5. supportedFields 是站点/插件能力声明，不是当前测试页面字段清单。
6. 区分两类缺失：
   - 「页面无此字段」：仅当前测试目标页面没有该信息（如本片无系列/无导演），站点模板仍支持；不要建议删除 supportedFields。
   - 「站点无此字段」或「站点详情页模板无此字段标签」：确认站点详情页类型从不提供该字段能力（如整站无简介区、无男优区）；应标为 ok，note 必须包含「站点无此字段」或「站点详情页模板无此字段标签」。${
     options.mode === 'create'
       ? '首次开发（create）模式下 verify 后会自动从 supportedFields 移除。'
       : '调试已安装插件时 verify 后只会自动新增 supportedFields，不会自动删除。'
   }
7. 若 verify 确认插件已正确解析某字段但 supportedFields 未声明，系统会在 verify 后自动新增该字段。
8. 并非每个${profile.verifySubjectLabel}页面都包含所有字段。若参考页面确实没有某字段的语义来源${profile.semanticAbsentFieldExamples}，且属于规则 6 的「页面无此字段」，插件留空正确，note 用「页面无此字段」。
9. missing_in_result / not_on_page 仅用于：页面存在该字段语义来源，但插件未返回或返回值与页面语义明显不符。
10. 仅返回 JSON：
{
  "summary": "一句总结",
  "items": [
    {
      "field": "maker",
      "status": "ok|missing_in_result|not_on_page|suspicious|invalid_key",
      "actual": "插件返回值，可选",
      "expected": "页面语义上更合理的值，可选",
      "note": "简短原因"
    }
  ]
}`
}

export function parseSemanticVerificationResponse(
  response: SemanticVerificationResponse
): { summary: string; items: PluginDevFieldVerification[] } {
  const items: PluginDevFieldVerification[] = []
  for (const item of response.items ?? []) {
    const field = readText(item.field)
    const status = readText(item.status) as PluginDevVerificationStatus | undefined
    if (!field || !status || !VALID_STATUSES.has(status)) continue
    items.push({
      field,
      status,
      actual: readText(item.actual),
      pageHint: readText(item.expected),
      note: readText(item.note) || '语义验证未通过'
    })
  }
  return {
    summary: readText(response.summary) || summarizeVerification(items),
    items
  }
}

export function formatVerificationForPrompt(report: PluginDevVerificationReport): string {
  if (!report.referencePage) {
    return `\n调试结果验证：${report.summary}\n`
  }

  const header = `参考页面：${report.referencePage.label} ${report.referencePage.url || '未知 URL'}`
  if (!report.items.length) {
    return `\n调试结果验证：\n${header}\n${report.summary}\n`
  }

  const lines = report.items.map((item) => {
    const actual = item.actual ? `返回值=${item.actual}` : '返回值=无'
    const hint = item.pageHint ? `页面语义=${item.pageHint}` : ''
    return `- ${item.field} [${statusLabel(item.status)}]：${item.note}（${[actual, hint].filter(Boolean).join('，')}）`
  })

  return `\n调试结果验证（必须据此判断调试结果是否正确；用户反馈与语义不一致的字段不得视为通过）：\n${header}\n${report.summary}\n${lines.join('\n')}\n`
}

export function formatFollowUpVerificationForPrompt(
  report: PluginDevVerificationReport,
  round: number,
  codeUnchanged: boolean
): string {
  const lines = report.items
    .filter((item) => isBlockingVerificationFailure(item))
    .map((item) => {
      const actual = item.actual ? `当前返回值=${item.actual}` : '当前返回值=无'
      const hint = item.pageHint ? `应为=${item.pageHint}` : ''
      return `- ${item.field} [${statusLabel(item.status)}]：${item.note}（${[actual, hint].filter(Boolean).join('，')}）`
    })

  return `\n上一轮修复后重跑验证仍未通过（第 ${round} 轮后续修复）：
${report.summary}
${lines.length ? `${lines.join('\n')}\n` : ''}${
    codeUnchanged
      ? '警告：上一轮返回的 code 与修复前完全相同，说明没有实质修改；本次必须修改 code 中的字段解析逻辑，禁止在 notes 中说“无需修改”。\n'
      : ''
  }必须以本轮重跑后的调试结果为准继续修复，直到用户反馈指出的字段语义正确为止。\n`
}

async function requestSemanticVerification(
  options: PluginDevVerificationOptions,
  referencePage: PluginDevPageInsight
): Promise<{ summary: string; items: PluginDevFieldVerification[] }> {
  const prompt = buildSemanticVerificationPrompt(options, referencePage)
  const response = await requestAgentJson<SemanticVerificationResponse>([
    {
      role: 'system',
      content:
        '你是刮削插件调试审核员。你只根据字段语义、参考页面内容和用户反馈判断调试结果是否正确。只返回 JSON。'
    },
    { role: 'user', content: prompt }
  ])
  return parseSemanticVerificationResponse(response)
}

function buildUserFeedbackVerificationItems(
  userFeedback: string | undefined
): PluginDevFieldVerification[] {
  const text = readText(userFeedback)
  if (!text) return []
  return [
    {
      field: 'user_feedback',
      status: 'suspicious',
      note: `用户反馈待处理：${text}`
    }
  ]
}

function buildFallbackSummary(
  referencePage: PluginDevPageInsight | undefined,
  userFeedback: string | undefined,
  items: PluginDevFieldVerification[]
): string {
  if (items.length > 0) return summarizeVerification(items)
  if (!referencePage) return '未获取到浏览器页面结构，无法做语义验证。'
  if (userFeedback?.trim()) return '调试结果为空；已记录用户反馈，需结合页面重新修复。'
  return '调试结果为空，无法对照页面验证。'
}

function mergeVerificationItems(
  ...groups: PluginDevFieldVerification[][]
): PluginDevFieldVerification[] {
  const merged = new Map<string, PluginDevFieldVerification>()
  const rank: Record<PluginDevVerificationStatus, number> = {
    invalid_key: 5,
    suspicious: 4,
    not_on_page: 3,
    missing_in_result: 2,
    ok: 1
  }

  for (const group of groups) {
    for (const item of group) {
      const existing = merged.get(item.field)
      if (!existing || rank[item.status] > rank[existing.status]) {
        merged.set(item.field, item)
      }
    }
  }

  return [...merged.values()]
}

function pickVerificationPage(discovery?: PluginDevDiscovery): PluginDevPageInsight | undefined {
  if (!discovery?.pages.length) return undefined
  const detailPage = [...discovery.pages]
    .reverse()
    .find((page) => /详情|调试/.test(page.label))
  return detailPage ?? discovery.pages[discovery.pages.length - 1]
}

function formatReferencePage(page: PluginDevPageInsight): string {
  return formatPageInsightForPrompt(page, { textLimit: 3200, linkLimit: 40 })
}

function readText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    const text = value.trim()
    return text || undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return undefined
}

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    const text = value.trim()
    return text || undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function stringifyForPrompt(value: unknown): string {
  if (value === undefined || value === null) return '无'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function summarizeVerification(items: PluginDevFieldVerification[]): string {
  if (!items.length) return '未生成字段级验证项。'
  const bad = items.filter((item) => isBlockingVerificationFailure(item))
  if (!bad.length) return '语义验证通过：字段值与页面语义一致。'
  const counts = {
    missing: bad.filter((item) => item.status === 'missing_in_result').length,
    notOnPage: bad.filter((item) => item.status === 'not_on_page').length,
    suspicious: bad.filter((item) => item.status === 'suspicious').length,
    invalid: bad.filter((item) => item.status === 'invalid_key').length
  }
  return `共 ${bad.length} 项需关注：缺失 ${counts.missing}，语义不符 ${counts.notOnPage + counts.suspicious}，无效字段名 ${counts.invalid}。`
}

function statusLabel(status: PluginDevVerificationStatus): string {
  if (status === 'ok') return '通过'
  if (status === 'missing_in_result') return '缺失'
  if (status === 'not_on_page') return '页面未找到'
  if (status === 'suspicious') return '不一致'
  return '无效字段名'
}
