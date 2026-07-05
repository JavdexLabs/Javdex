import { normalizeCupSize } from '@shared/cupSizeUtils'
import type {
  ActressGender,
  ActressScrapeResult,
  ScrapeResult,
  ScrapedActress
} from '@shared/types'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readString(obj: UnknownRecord, key: string): string | undefined {
  const value = obj[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`Invalid scraper result: ${key} must be a string`)
  const text = value.trim()
  return text || undefined
}

function readDate(obj: UnknownRecord, key: string): string | undefined {
  const value = readString(obj, key)
  if (!value) return undefined
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) {
    throw new Error(`Invalid scraper result: ${key} must use YYYY-MM-DD`)
  }
  return formatValidDate(match[1], match[2], match[3], key)
}

function readFlexibleDate(obj: UnknownRecord, key: string): string | undefined {
  const raw = obj[key]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new Error(`Invalid scraper result: ${key} must be a string`)
  }
  const text = raw.trim()
  if (!text) return undefined
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (iso) return formatValidDate(iso[1], iso[2], iso[3], key)

  const full = text.match(/(\d{4})\D{0,3}(\d{1,2})\D{0,3}(\d{1,2})/)
  if (full) return formatValidDate(full[1], full[2], full[3], key)

  const monthOnly = text.match(/(\d{4})\D{0,3}(\d{1,2})(?:\s*月|\s*$)/)
  if (monthOnly) return formatValidDate(monthOnly[1], monthOnly[2], '1', key)

  throw new Error(`Invalid scraper result: ${key} must use YYYY-MM-DD`)
}

function formatValidDate(year: string, month: string, day: string, key: string): string {
  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  const date = new Date(Date.UTC(y, m - 1, d))
  const valid =
    Number.isInteger(y) &&
    Number.isInteger(m) &&
    Number.isInteger(d) &&
    m >= 1 &&
    m <= 12 &&
    d >= 1 &&
    d <= 31 &&
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  if (!valid) throw new Error(`Invalid scraper result: ${key} must use a valid YYYY-MM-DD`)
  return `${year.padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function readNumber(obj: UnknownRecord, key: string): number | undefined {
  const value = obj[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid scraper result: ${key} must be a finite number`)
  }
  return value
}

function readNonNegativeNumber(obj: UnknownRecord, key: string): number | undefined {
  const value = readNumber(obj, key)
  if (value === undefined) return undefined
  if (value < 0) throw new Error(`Invalid scraper result: ${key} cannot be negative`)
  return value
}

function readVideoRatingAverage(obj: UnknownRecord): number | undefined {
  const value = obj.ratingAverage
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value <= 0 || value > 5) return undefined

  const rounded = Math.round(value * 10) / 10
  return rounded > 0 && rounded <= 5 ? rounded : undefined
}

function readVideoRatingCount(obj: UnknownRecord): number | undefined {
  const value = obj.ratingCount
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

function assignVideoRating(result: ScrapeResult, obj: UnknownRecord): void {
  const ratingAverage = readVideoRatingAverage(obj)
  if (ratingAverage === undefined) return

  result.ratingAverage = ratingAverage

  const ratingCount = readVideoRatingCount(obj)
  if (ratingCount !== undefined) {
    result.ratingCount = ratingCount
  }
}

function readFlexibleNumber(obj: UnknownRecord, key: string): number | undefined {
  const value = obj[key]
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const match = value.trim().match(/(\d+(?:\.\d+)?)/)
    if (match) {
      const parsed = Number(match[1])
      if (Number.isFinite(parsed)) return parsed
    }
  }
  throw new Error(`Invalid scraper result: ${key} must be a finite number`)
}

function readFlexibleNonNegativeNumber(obj: UnknownRecord, key: string): number | undefined {
  const value = readFlexibleNumber(obj, key)
  if (value === undefined) return undefined
  if (value < 0) throw new Error(`Invalid scraper result: ${key} cannot be negative`)
  return value
}

function readStringArray(obj: UnknownRecord, key: string): string[] | undefined {
  const value = obj[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error(`Invalid scraper result: ${key} must be an array`)

  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`Invalid scraper result: ${key} entries must be strings`)
    }
    const text = item.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

function readGender(value: unknown): ActressGender | undefined {
  if (value === undefined || value === null) return undefined
  if (value === 'female' || value === 'male') return value
  throw new Error('Invalid scraper result: actress gender must be female or male')
}

function readScrapedActresses(obj: UnknownRecord): ScrapedActress[] | undefined {
  const value = obj.actresses
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new Error('Invalid scraper result: actresses must be an array')
  }

  const out: ScrapedActress[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) {
      throw new Error('Invalid scraper result: actress entries must be objects')
    }
    const name = readString(item, 'name')
    if (!name) continue
    const gender = readGender(item.gender)
    const avatarUrl = readString(item, 'avatarUrl')
    const key = `${gender ?? 'unknown'}:${name}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name, ...(avatarUrl ? { avatarUrl } : {}), ...(gender ? { gender } : {}) })
  }
  return out
}

function assignString(
  result: object,
  obj: UnknownRecord,
  key: string,
  targetKey = key
): void {
  const value = readString(obj, key)
  if (value !== undefined) {
    ;(result as Record<string, unknown>)[targetKey] = value
  }
}

function assignDate(
  result: object,
  obj: UnknownRecord,
  key: string,
  targetKey = key
): void {
  const value = readDate(obj, key)
  if (value !== undefined) {
    ;(result as Record<string, unknown>)[targetKey] = value
  }
}

function assignNumber(
  result: object,
  obj: UnknownRecord,
  key: string,
  targetKey = key,
  nonNegative = false
): void {
  const value = nonNegative ? readNonNegativeNumber(obj, key) : readNumber(obj, key)
  if (value !== undefined) {
    ;(result as Record<string, unknown>)[targetKey] = value
  }
}

function assignFlexibleDate(
  result: object,
  obj: UnknownRecord,
  key: string,
  targetKey = key
): void {
  const value = readFlexibleDate(obj, key)
  if (value !== undefined) {
    ;(result as Record<string, unknown>)[targetKey] = value
  }
}

function assignFlexibleNumber(
  result: object,
  obj: UnknownRecord,
  key: string,
  targetKey = key,
  nonNegative = false
): void {
  const value = nonNegative ? readFlexibleNonNegativeNumber(obj, key) : readFlexibleNumber(obj, key)
  if (value !== undefined) {
    ;(result as Record<string, unknown>)[targetKey] = value
  }
}

export function normalizeVideoScrapeResult(
  value: unknown,
  fallbackCode: string
): ScrapeResult | null {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) throw new Error('Invalid scraper result: expected an object or null')

  const code = readString(value, 'code') ?? fallbackCode
  const result: ScrapeResult = { code }

  assignString(result, value, 'title')
  assignString(result, value, 'summary')
  assignString(result, value, 'coverUrl')
  assignDate(result, value, 'releaseDate')
  assignString(result, value, 'maker')
  assignString(result, value, 'publisher')
  assignString(result, value, 'series')
  assignString(result, value, 'director')
  assignNumber(result, value, 'durationSeconds', 'durationSeconds', true)
  assignString(result, value, 'sourceUrl')
  assignVideoRating(result, value)

  const sampleImageUrls = readStringArray(value, 'sampleImageUrls')
  if (sampleImageUrls) result.sampleImageUrls = sampleImageUrls

  const actresses = readScrapedActresses(value)
  if (actresses) result.actresses = actresses

  const tags = readStringArray(value, 'tags')
  if (tags) result.tags = tags

  return result
}

export function normalizeActressScrapeResult(value: unknown): ActressScrapeResult | null {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) throw new Error('Invalid scraper result: expected an object or null')

  const result: ActressScrapeResult = {}

  assignString(result, value, 'mainName')
  assignString(result, value, 'nameZh')
  assignString(result, value, 'nameEn')
  assignString(result, value, 'avatarUrl')
  assignFlexibleDate(result, value, 'birthDate')
  assignFlexibleDate(result, value, 'debutDate')
  assignFlexibleNumber(result, value, 'heightCm', 'heightCm', true)
  assignFlexibleNumber(result, value, 'bustCm', 'bustCm', true)
  assignFlexibleNumber(result, value, 'waistCm', 'waistCm', true)
  assignFlexibleNumber(result, value, 'hipCm', 'hipCm', true)
  assignString(result, value, 'cupSize')
  if (result.cupSize) {
    result.cupSize = normalizeCupSize(result.cupSize) ?? undefined
  }
  assignString(result, value, 'bloodType')
  assignString(result, value, 'zodiac')
  assignString(result, value, 'nationality')
  assignString(result, value, 'profileSummary')
  assignString(result, value, 'sourceUrl')

  const galleryImageUrls = readStringArray(value, 'galleryImageUrls')
  if (galleryImageUrls) result.galleryImageUrls = galleryImageUrls

  const aliases = readStringArray(value, 'aliases')
  if (aliases) result.aliases = aliases

  return result
}
