import { XMLParser, XMLValidator } from 'fast-xml-parser'
import type { ActressGender } from '@shared/actressTypes'
import { normalizeVideoCode } from '@shared/videoCode'

export const MAX_NFO_BYTES = 2 * 1024 * 1024
export const MAX_NFO_DEPTH = 64
export const MAX_NFO_NODES = 50_000
export const MAX_NFO_FIELD_BYTES = 256 * 1024

export type NfoDialect = 'mdc' | 'mdcx' | 'javinizer' | 'javsp' | 'unknown'

export type NfoArtifactWarningCode =
  | 'unknown-dialect'
  | 'unknown-tag'
  | 'lossy-field'
  | 'invalid-field'
  | 'remote-image-ignored'

export interface NfoArtifactWarning {
  code: NfoArtifactWarningCode
  message: string
}

export interface NormalizedNfoActor {
  name: string
  declaredGender?: ActressGender
  thumbReferences: string[]
}

/** Private normalized representation shared by the importer and later profile renderer. */
export interface NormalizedNfoArtifact {
  dialect: NfoDialect
  code: string | null
  title?: string
  summary?: string
  releaseDate?: string
  maker?: string
  publisher?: string
  series?: string
  director?: string
  durationSeconds?: number
  ratingAverage?: number
  ratingCount?: number
  tags: string[]
  actors: NormalizedNfoActor[]
  coverReferences: string[]
  sampleReferences: string[]
}

export interface ParsedNfoArtifact {
  model: NormalizedNfoArtifact
  warnings: NfoArtifactWarning[]
}

const renderOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

function assertRenderableField(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, '\uFFFD')
    .replace(/\r\n?/gu, '\n')
    .trim()
  if (Buffer.byteLength(normalized, 'utf8') > MAX_NFO_FIELD_BYTES) {
    throw new NfoArtifactError('field-too-large')
  }
  return normalized
}

function escapeXml(value: string): string {
  return assertRenderableField(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;')
}

function renderElement(name: string, value: string, indent = '  '): string {
  return `${indent}<${name}>${escapeXml(value)}</${name}>`
}

/** Stable Javdex interchange rendering; profile-specific export remains outside the codec. */
export function renderNfoArtifact(model: NormalizedNfoArtifact): Buffer {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<movie>']
  if (model.code) {
    lines.push(`  <uniqueid type="num" default="true">${escapeXml(model.code)}</uniqueid>`)
  }
  if (model.title) lines.push(renderElement('title', model.title))
  if (model.summary) lines.push(renderElement('plot', model.summary))
  if (model.releaseDate) lines.push(renderElement('premiered', model.releaseDate))
  if (model.maker) lines.push(renderElement('studio', model.maker))
  if (model.publisher) lines.push(renderElement('publisher', model.publisher))
  if (model.series) {
    lines.push('  <set>')
    lines.push(renderElement('name', model.series, '    '))
    lines.push('  </set>')
  }
  if (model.director) lines.push(renderElement('director', model.director))
  if (model.durationSeconds != null && model.durationSeconds > 0) {
    const minutes = Math.round((model.durationSeconds / 60) * 100) / 100
    lines.push(renderElement('runtime', String(minutes)))
  }
  if (model.ratingAverage != null) {
    lines.push('  <ratings>')
    lines.push('    <rating name="javdex" max="5" default="true">')
    lines.push(renderElement('value', String(model.ratingAverage), '      '))
    if (model.ratingCount != null) {
      lines.push(renderElement('votes', String(model.ratingCount), '      '))
    }
    lines.push('    </rating>')
    lines.push('  </ratings>')
  }
  for (const tag of stableUnique([...model.tags]).sort(renderOrder.compare)) {
    lines.push(renderElement('tag', tag))
  }
  for (const actor of [...model.actors].sort((left, right) =>
    renderOrder.compare(left.name, right.name)
  )) {
    lines.push('  <actor>')
    lines.push(renderElement('name', actor.name, '    '))
    if (actor.declaredGender) {
      lines.push(renderElement('gender', actor.declaredGender, '    '))
    }
    for (const reference of stableUnique([...actor.thumbReferences]).sort(renderOrder.compare)) {
      lines.push(renderElement('thumb', reference, '    '))
    }
    lines.push('  </actor>')
  }
  for (const reference of stableUnique([...model.coverReferences]).sort(renderOrder.compare)) {
    lines.push(`  <thumb aspect="poster">${escapeXml(reference)}</thumb>`)
  }
  const samples = stableUnique([...model.sampleReferences]).sort(renderOrder.compare)
  if (samples.length > 0) {
    lines.push('  <fanart>')
    for (const reference of samples) lines.push(renderElement('thumb', reference, '    '))
    lines.push('  </fanart>')
  }
  lines.push('</movie>', '')
  const output = Buffer.from(lines.join('\n'), 'utf8')
  if (output.byteLength > MAX_NFO_BYTES) throw new NfoArtifactError('too-large')
  return output
}

export type NfoArtifactErrorCode =
  | 'too-large'
  | 'invalid-utf8'
  | 'unsafe-xml'
  | 'too-deep'
  | 'too-many-nodes'
  | 'field-too-large'
  | 'invalid-xml'
  | 'not-a-movie'

const NFO_ERROR_MESSAGES: Record<NfoArtifactErrorCode, string> = {
  'too-large': 'NFO 文件超过 2 MiB',
  'invalid-utf8': 'NFO 文件不是有效的 UTF-8 文本',
  'unsafe-xml': 'NFO 包含不允许的 DTD 或实体声明',
  'too-deep': 'NFO XML 嵌套深度超过 64',
  'too-many-nodes': 'NFO XML 节点数超过 50,000',
  'field-too-large': 'NFO 单字段超过 256 KiB',
  'invalid-xml': 'NFO XML 无效',
  'not-a-movie': 'NFO 不包含 movie 根节点'
}

export class NfoArtifactError extends Error {
  constructor(readonly code: NfoArtifactErrorCode) {
    super(NFO_ERROR_MESSAGES[code])
    this.name = 'NfoArtifactError'
  }
}

type XmlRecord = Record<string, unknown>

const ROOT_TAGS = new Set([
  'actor',
  'director',
  'fanart',
  'genre',
  'id',
  'label',
  'maker',
  'num',
  'originalplot',
  'originaltitle',
  'outline',
  'plot',
  'premiered',
  'publisher',
  'rating',
  'ratings',
  'release',
  'releasedate',
  'runtime',
  'series',
  'set',
  'studio',
  'tag',
  'thumb',
  'title',
  'uniqueid'
])

const CHILD_TAGS = new Map<string, ReadonlySet<string>>([
  ['movie', ROOT_TAGS],
  ['movie.actor', new Set(['name', 'altname', 'thumb', 'role', 'gender', 'sex'])],
  ['movie.fanart', new Set(['thumb'])],
  ['movie.ratings', new Set(['rating'])],
  ['movie.ratings.rating', new Set(['value', 'votes'])],
  ['movie.set', new Set(['name'])]
])

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  trimValues: false,
  allowBooleanAttributes: false,
  isArray: (_name, jPath) =>
    [
      'movie.actor',
      'movie.director',
      'movie.fanart.thumb',
      'movie.genre',
      'movie.ratings.rating',
      'movie.tag',
      'movie.thumb',
      'movie.uniqueid'
    ].includes(String(jPath))
})

function decodeUtf8(content: Uint8Array): string {
  if (content.byteLength > MAX_NFO_BYTES) throw new NfoArtifactError('too-large')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content).replace(/^\uFEFF/u, '')
  } catch {
    throw new NfoArtifactError('invalid-utf8')
  }
}

function inspectStructure(value: string): void {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(value)) throw new NfoArtifactError('unsafe-xml')

  const withoutOpaqueSections = value
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gu, '')
    .replace(/<\?[\s\S]*?\?>/gu, '')
  const tags = withoutOpaqueSections.match(/<[^>]+>/gu) ?? []
  let depth = 0
  let nodes = 0
  for (const tag of tags) {
    if (/^<\s*\//u.test(tag)) {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (/^<\s*!/u.test(tag)) throw new NfoArtifactError('unsafe-xml')
    nodes += 1
    if (nodes > MAX_NFO_NODES) throw new NfoArtifactError('too-many-nodes')
    if (!/\/\s*>$/u.test(tag)) {
      depth += 1
      if (depth > MAX_NFO_DEPTH) throw new NfoArtifactError('too-deep')
    }
  }
}

function isRecord(value: unknown): value is XmlRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function collectUnknownTagWarnings(
  value: XmlRecord,
  path: string,
  warnings: NfoArtifactWarning[],
  seen = new Set<string>()
): void {
  const allowed = CHILD_TAGS.get(path)
  if (!allowed) return
  for (const [tag, child] of Object.entries(value)) {
    if (tag.startsWith('@_') || tag === '#text') continue
    if (!allowed.has(tag)) {
      const key = `${path}:${tag}`
      if (seen.has(key)) continue
      seen.add(key)
      const displayTag = tag.length > 80 ? `${tag.slice(0, 77)}...` : tag
      warnings.push({ code: 'unknown-tag', message: `NFO 未知标签 <${displayTag}> 已忽略` })
      continue
    }
    const childPath = `${path}.${tag}`
    if (!CHILD_TAGS.has(childPath)) continue
    for (const item of asArray(child)) {
      if (isRecord(item)) collectUnknownTagWarnings(item, childPath, warnings, seen)
    }
  }
}

function asArray(value: unknown): unknown[] {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function decodeBuiltInXmlReferences(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'"
  }
  return value
    .replace(/&(amp|lt|gt|quot|apos);/gu, (_match, name: string) => named[name] ?? _match)
    .replace(/&#(x[0-9a-f]+|\d+);/giu, (match, raw: string) => {
      const codePoint = raw.toLowerCase().startsWith('x')
        ? Number.parseInt(raw.slice(1), 16)
        : Number.parseInt(raw, 10)
      try {
        return Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : match
      } catch {
        return match
      }
    })
}

function text(value: unknown): string | null {
  const raw = isRecord(value) ? value['#text'] : value
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const normalized = decodeBuiltInXmlReferences(String(raw)).replace(/\s+/gu, ' ').trim()
  if (!normalized) return null
  if (Buffer.byteLength(normalized, 'utf8') > MAX_NFO_FIELD_BYTES) {
    throw new NfoArtifactError('field-too-large')
  }
  return normalized
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    for (const candidate of asArray(value)) {
      const normalized = text(candidate)
      if (normalized) return normalized
    }
  }
  return undefined
}

function normalizeCode(value: string | undefined): string | null {
  if (!value) return null
  try {
    return normalizeVideoCode(value)
  } catch {
    return null
  }
}

function typedUniqueId(movie: XmlRecord, type: string): string | undefined {
  for (const value of asArray(movie.uniqueid)) {
    if (!isRecord(value) || String(value['@_type'] ?? '').trim().toLowerCase() !== type) continue
    const id = text(value)
    if (id) return id
  }
  return undefined
}

function detectDialect(movie: XmlRecord): NfoDialect {
  if (movie.num != null && (movie.publisher != null || movie.series != null || movie.originalplot != null)) {
    return 'mdcx'
  }
  if (typedUniqueId(movie, 'num')) return 'javsp'
  if (movie.num != null) return 'mdc'
  if (movie.id != null) return 'javinizer'
  return 'unknown'
}

function normalizeDate(value: string | undefined, warnings: NfoArtifactWarning[]): string | undefined {
  if (!value) return undefined
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/u.exec(value)
  if (!match) {
    warnings.push({ code: 'invalid-field', message: 'NFO 发行日期格式无效，已忽略' })
    return undefined
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    warnings.push({ code: 'invalid-field', message: 'NFO 发行日期格式无效，已忽略' })
    return undefined
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function normalizeRuntime(value: string | undefined, warnings: NfoArtifactWarning[]): number | undefined {
  if (!value) return undefined
  const match = /^(\d+(?:\.\d+)?)\s*(?:min(?:ute)?s?|分钟)?$/iu.exec(value)
  if (!match) {
    warnings.push({ code: 'invalid-field', message: 'NFO 时长格式无效，已忽略' })
    return undefined
  }
  const minutes = Number(match[1])
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined
  return Math.round(minutes * 60)
}

function normalizeGender(value: string | undefined): ActressGender | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (['female', 'f', 'woman', '女优', '女優', '女'].includes(normalized)) return 'female'
  if (['male', 'm', 'man', '男优', '男優', '男'].includes(normalized)) return 'male'
  return undefined
}

function stableUnique(values: string[]): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const value of values) {
    const key = value.toLocaleLowerCase('en-US')
    if (seen.has(key)) continue
    seen.add(key)
    output.push(value)
  }
  return output
}

function isRemoteReference(value: string): boolean {
  return /^(?:https?|ftp):\/\//iu.test(value)
}

function localReferences(
  values: unknown[],
  warnings: NfoArtifactWarning[]
): string[] {
  const result: string[] = []
  for (const value of values) {
    const reference = text(value)
    if (!reference) continue
    if (isRemoteReference(reference)) {
      warnings.push({ code: 'remote-image-ignored', message: 'NFO 中的远程图片已忽略' })
      continue
    }
    result.push(reference)
  }
  return stableUnique(result)
}

function parseActors(movie: XmlRecord, warnings: NfoArtifactWarning[]): NormalizedNfoActor[] {
  const actors: NormalizedNfoActor[] = []
  const seen = new Set<string>()
  for (const value of asArray(movie.actor)) {
    if (!isRecord(value)) continue
    const name = firstText(value.name)
    if (!name) continue
    const key = name.toLocaleLowerCase('en-US')
    if (seen.has(key)) continue
    seen.add(key)
    actors.push({
      name,
      ...(normalizeGender(firstText(value.gender, value.sex))
        ? { declaredGender: normalizeGender(firstText(value.gender, value.sex)) }
        : {}),
      thumbReferences: localReferences(asArray(value.thumb), warnings)
    })
  }
  return actors
}

function parseRating(
  movie: XmlRecord,
  dialect: NfoDialect,
  warnings: NfoArtifactWarning[]
): { average?: number; count?: number } {
  const structured = isRecord(movie.ratings) ? asArray(movie.ratings.rating) : []
  for (const value of structured) {
    if (!isRecord(value)) continue
    const raw = Number(firstText(value.value, value['#text']))
    const max = Number(firstText(value['@_max']))
    if (!Number.isFinite(raw) || !Number.isFinite(max) || raw < 0 || max <= 0) continue
    const average = Math.round((raw / max) * 50) / 10
    const votes = Number(firstText(value.votes))
    return {
      average: Math.max(0, Math.min(5, average)),
      ...(Number.isSafeInteger(votes) && votes >= 0 ? { count: votes } : {})
    }
  }

  const scalar = Number(firstText(movie.rating))
  if (Number.isFinite(scalar) && scalar >= 0 && dialect !== 'unknown') {
    return { average: Math.max(0, Math.min(5, scalar > 5 ? scalar / 2 : scalar)) }
  }
  if (movie.rating != null && dialect === 'unknown') {
    warnings.push({ code: 'invalid-field', message: '未知 NFO 方言的无量表评分已忽略' })
  }
  return {}
}

function parseSeries(movie: XmlRecord): string | undefined {
  if (firstText(movie.series)) return firstText(movie.series)
  if (isRecord(movie.set)) return firstText(movie.set.name, movie.set['#text'])
  return firstText(movie.set)
}

function parseTags(movie: XmlRecord): string[] {
  const ordered = Object.entries(movie).flatMap(([key, value]) =>
    key === 'tag' || key === 'genre' ? asArray(value) : []
  )
  return stableUnique(ordered.map(text).filter((value): value is string => Boolean(value)))
}

function parseMovie(value: unknown): XmlRecord {
  if (!isRecord(value) || !isRecord(value.movie)) throw new NfoArtifactError('not-a-movie')
  return value.movie
}

export function parseNfoArtifact(content: Uint8Array): ParsedNfoArtifact {
  const source = decodeUtf8(content)
  inspectStructure(source)
  if (XMLValidator.validate(source, { allowBooleanAttributes: false }) !== true) {
    throw new NfoArtifactError('invalid-xml')
  }

  let movie: XmlRecord
  try {
    movie = parseMovie(parser.parse(source) as unknown)
  } catch (error) {
    if (error instanceof NfoArtifactError) throw error
    throw new NfoArtifactError('invalid-xml')
  }

  const warnings: NfoArtifactWarning[] = []
  const dialect = detectDialect(movie)
  if (dialect === 'unknown') {
    warnings.push({ code: 'unknown-dialect', message: 'NFO 方言无法识别，已按通用字段读取' })
  }
  collectUnknownTagWarnings(movie, 'movie', warnings)

  const directors = asArray(movie.director)
    .map(text)
    .filter((value): value is string => Boolean(value))
  if (directors.length > 1) {
    warnings.push({ code: 'lossy-field', message: 'NFO 包含多个导演，仅导入第一位' })
  }

  const coverReferences = localReferences(
    asArray(movie.thumb).filter(
      (value) => !isRecord(value) || !value['@_aspect'] || value['@_aspect'] === 'poster'
    ),
    warnings
  )
  const sampleReferences = localReferences(
    isRecord(movie.fanart) ? asArray(movie.fanart.thumb) : [],
    warnings
  )
  const actors = parseActors(movie, warnings)
  const rating = parseRating(movie, dialect, warnings)
  const tags = parseTags(movie)
  const releaseDate = normalizeDate(
    firstText(movie.premiered, movie.releasedate, movie.release),
    warnings
  )
  const durationSeconds = normalizeRuntime(firstText(movie.runtime), warnings)

  return {
    model: {
      dialect,
      code: normalizeCode(firstText(movie.num, typedUniqueId(movie, 'num'), movie.id)),
      ...(firstText(movie.title, movie.originaltitle)
        ? { title: firstText(movie.title, movie.originaltitle) }
        : {}),
      ...(firstText(movie.plot, movie.outline, movie.originalplot)
        ? { summary: firstText(movie.plot, movie.outline, movie.originalplot) }
        : {}),
      ...(releaseDate ? { releaseDate } : {}),
      ...(firstText(movie.maker, movie.studio)
        ? { maker: firstText(movie.maker, movie.studio) }
        : {}),
      ...(firstText(movie.publisher, movie.label)
        ? { publisher: firstText(movie.publisher, movie.label) }
        : {}),
      ...(parseSeries(movie) ? { series: parseSeries(movie) } : {}),
      ...(directors[0] ? { director: directors[0] } : {}),
      ...(durationSeconds ? { durationSeconds } : {}),
      ...(rating.average !== undefined ? { ratingAverage: rating.average } : {}),
      ...(rating.count !== undefined ? { ratingCount: rating.count } : {}),
      tags,
      actors,
      coverReferences,
      sampleReferences
    },
    warnings
  }
}
