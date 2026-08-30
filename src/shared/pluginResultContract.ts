import type { ActressScrapeField, ActressScrapeResult } from './actressScrapeTypes'
import type { ScraperPluginKind } from './scraperPluginTypes'
import type { ScrapeResult, VideoScrapeField } from './videoScrapeTypes'

export type PluginResultKeyRole = 'identity' | 'field' | 'diagnostic'
export type PluginResultProjection = 'always' | 'selected' | 'plugin-only'

export interface PluginResultKeyContract {
  key: string
  role: PluginResultKeyRole
  fieldIds: Array<VideoScrapeField | ActressScrapeField>
  projection: PluginResultProjection
  partition?: 'gender'
}

export interface PluginResultContract {
  kind: ScraperPluginKind
  keys: PluginResultKeyContract[]
}

export interface PluginManifestCoverage {
  returnedFieldIds: Array<VideoScrapeField | ActressScrapeField>
  undeclaredReturnedFieldIds: Array<VideoScrapeField | ActressScrapeField>
  runtimeOnlyKeys: Array<{
    key: string
    role: 'identity' | 'diagnostic'
  }>
}

function keyContract(
  key: string,
  role: PluginResultKeyRole,
  fieldIds: Array<VideoScrapeField | ActressScrapeField>,
  projection: PluginResultProjection,
  partition?: 'gender'
): PluginResultKeyContract {
  return { key, role, fieldIds, projection, ...(partition ? { partition } : {}) }
}

export const VIDEO_RESULT_KEY_CONTRACTS = {
  code: keyContract('code', 'identity', [], 'always'),
  title: keyContract('title', 'field', ['title'], 'selected'),
  summary: keyContract('summary', 'field', ['summary'], 'selected'),
  coverUrl: keyContract('coverUrl', 'field', ['cover'], 'selected'),
  releaseDate: keyContract('releaseDate', 'field', ['releaseDate'], 'selected'),
  maker: keyContract('maker', 'field', ['maker'], 'selected'),
  publisher: keyContract('publisher', 'field', ['publisher'], 'selected'),
  series: keyContract('series', 'field', ['series'], 'selected'),
  director: keyContract('director', 'field', ['director'], 'selected'),
  durationSeconds: keyContract('durationSeconds', 'field', ['duration'], 'selected'),
  sourceUrl: keyContract('sourceUrl', 'field', ['source'], 'selected'),
  ratingAverage: keyContract('ratingAverage', 'field', ['rating'], 'selected'),
  ratingCount: keyContract('ratingCount', 'field', ['rating'], 'selected'),
  sampleImageUrls: keyContract('sampleImageUrls', 'field', ['samples'], 'selected'),
  actresses: keyContract(
    'actresses',
    'field',
    ['actressesFemale', 'actressesMale'],
    'selected',
    'gender'
  ),
  tags: keyContract('tags', 'field', ['tags'], 'selected')
} satisfies Record<keyof ScrapeResult, PluginResultKeyContract>

export const ACTRESS_RESULT_KEY_CONTRACTS = {
  mainName: keyContract('mainName', 'identity', [], 'plugin-only'),
  nameZh: keyContract('nameZh', 'field', ['nameZh'], 'selected'),
  nameEn: keyContract('nameEn', 'field', ['nameEn'], 'selected'),
  avatarUrl: keyContract('avatarUrl', 'field', ['avatar'], 'selected'),
  birthDate: keyContract('birthDate', 'field', ['birthDate'], 'selected'),
  debutDate: keyContract('debutDate', 'field', ['debutDate'], 'selected'),
  heightCm: keyContract('heightCm', 'field', ['heightCm'], 'selected'),
  bustCm: keyContract('bustCm', 'field', ['measurements'], 'selected'),
  waistCm: keyContract('waistCm', 'field', ['measurements'], 'selected'),
  hipCm: keyContract('hipCm', 'field', ['measurements'], 'selected'),
  cupSize: keyContract('cupSize', 'field', ['cupSize'], 'selected'),
  bloodType: keyContract('bloodType', 'field', ['bloodType'], 'selected'),
  zodiac: keyContract('zodiac', 'field', ['zodiac'], 'selected'),
  nationality: keyContract('nationality', 'field', ['nationality'], 'selected'),
  profileSummary: keyContract('profileSummary', 'field', ['profileSummary'], 'selected'),
  galleryImageUrls: keyContract('galleryImageUrls', 'field', ['gallery'], 'selected'),
  aliases: keyContract('aliases', 'field', ['aliases'], 'selected'),
  sourceUrl: keyContract('sourceUrl', 'diagnostic', [], 'plugin-only')
} satisfies Record<keyof ActressScrapeResult, PluginResultKeyContract>

function records(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object' && !Array.isArray(item)
    )
  }
  return value && typeof value === 'object'
    ? [value as Record<string, unknown>]
    : []
}

function hasMaterialValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.some(hasMaterialValue)
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasMaterialValue)
  }
  return false
}

function castPartitionHasValue(
  rows: Array<Record<string, unknown>>,
  gender: 'female' | 'male'
): boolean {
  return rows.some((row) => Array.isArray(row.actresses) && row.actresses.some((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const actress = item as Record<string, unknown>
    const actualGender = actress.gender ?? 'female'
    return actualGender === gender && hasMaterialValue(actress.name)
  }))
}

function returnedFields(
  kind: ScraperPluginKind,
  value: unknown
): Array<VideoScrapeField | ActressScrapeField> {
  const rows = records(value)
  if (rows.length === 0) return []
  const fields: Array<VideoScrapeField | ActressScrapeField> = []
  for (const contract of contractsForKind(kind)) {
    if (contract.role !== 'field') continue
    if (contract.partition === 'gender') {
      if (castPartitionHasValue(rows, 'female')) fields.push('actressesFemale')
      if (castPartitionHasValue(rows, 'male')) fields.push('actressesMale')
      continue
    }
    if (!rows.some((row) => hasMaterialValue(row[contract.key]))) continue
    for (const field of contract.fieldIds) {
      if (!fields.includes(field)) fields.push(field)
    }
  }
  return fields
}

function contractsForKind(kind: ScraperPluginKind): PluginResultKeyContract[] {
  const source = kind === 'video' ? VIDEO_RESULT_KEY_CONTRACTS : ACTRESS_RESULT_KEY_CONTRACTS
  return Object.values(source).map((item) => ({ ...item, fieldIds: [...item.fieldIds] }))
}

/** Pure contract seam shared by prompt generation, dry-run projection facts and acceptance. */
export class PluginResultContractModule {
  describe(kind: ScraperPluginKind): PluginResultContract {
    return { kind, keys: contractsForKind(kind) }
  }

  unrecognizedResultKeys(kind: ScraperPluginKind, rawResult: unknown): string[] {
    const recognizedKeys = new Set(contractsForKind(kind).map((item) => item.key))
    const unrecognized = new Set<string>()
    for (const row of records(rawResult)) {
      for (const key of Object.keys(row)) {
        if (!recognizedKeys.has(key)) unrecognized.add(key)
      }
    }
    return [...unrecognized]
  }

  analyze(input: {
    kind: ScraperPluginKind
    pluginResult: unknown
    effectiveResult: unknown
    declaredFields: readonly string[]
  }): { manifestCoverage: PluginManifestCoverage; materialAccepted: boolean } {
    const returnedFieldIds = returnedFields(input.kind, input.pluginResult)
    const declared = new Set(input.declaredFields)
    const runtimeOnlyKeys = contractsForKind(input.kind)
      .filter((item): item is PluginResultKeyContract & {
        role: 'identity' | 'diagnostic'
      } => item.projection === 'plugin-only' && item.role !== 'field')
      .filter((item) => records(input.pluginResult).some((row) => hasMaterialValue(row[item.key])))
      .map((item) => ({ key: item.key, role: item.role }))

    return {
      manifestCoverage: {
        returnedFieldIds,
        undeclaredReturnedFieldIds: returnedFieldIds.filter((field) => !declared.has(field)),
        runtimeOnlyKeys
      },
      materialAccepted: returnedFields(input.kind, input.effectiveResult)
        .some((field) => field !== 'source')
    }
  }
}

export const pluginResultContract = new PluginResultContractModule()
