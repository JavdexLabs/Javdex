const MAX_EXACT_CANDIDATES = 8
const MAX_SAMPLE_IMAGES = 40
const DETAIL_CONCURRENCY = 4

function objectValue(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`MetaTube ${label}响应格式不兼容`)
  }
  return value
}

function envelopeData(payload, label) {
  const envelope = objectValue(payload, label)
  if (!Object.prototype.hasOwnProperty.call(envelope, 'data')) {
    throw new Error(`MetaTube ${label}响应缺少 data 字段`)
  }
  return envelope.data
}

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`MetaTube 响应缺少有效字段 ${field}`)
  }
  return value.trim()
}

function optionalText(value, field, helpers) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`MetaTube 字段 ${field} 类型不兼容`)
  return helpers.normalizeText(value) || undefined
}

function optionalNumber(value, field) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`MetaTube 字段 ${field} 类型不兼容`)
  }
  return value
}

function stringArray(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`MetaTube 字段 ${field} 类型不兼容`)
  }
  return value
}

function normalizedComparableCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
}

function normalizedResultCode(value) {
  return String(value || '').trim().toUpperCase()
}

function validDate(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('MetaTube 字段 release_date 类型不兼容')
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? value.trim()
    : undefined
}

function validHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.toString()
      : undefined
  } catch (_error) {
    return undefined
  }
}

function optionalHttpUrl(value, field) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`MetaTube 字段 ${field} 类型不兼容`)
  return validHttpUrl(value)
}

async function mapLimit(values, concurrency, mapper) {
  const results = new Array(values.length)
  let nextIndex = 0
  async function worker() {
    while (true) {
      const index = nextIndex++
      if (index >= values.length) return
      results[index] = await mapper(values[index], index)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
  )
  return results
}

function cleanStrings(values, helpers) {
  return helpers.unique(values.map((value) => helpers.normalizeText(value)).filter(Boolean))
}

function mapDetail(ctx, queryCode, searchIdentity, payload) {
  const detail = objectValue(envelopeData(payload, '影片详情'), '影片详情 data')
  const id = requiredText(detail.id, 'id')
  const provider = requiredText(detail.provider, 'provider')
  const number = requiredText(detail.number, 'number')
  const title = requiredText(detail.title, 'title')
  if (id !== searchIdentity.id || provider !== searchIdentity.provider) {
    throw new Error('MetaTube 影片详情身份与搜索结果不一致')
  }
  if (normalizedComparableCode(number) !== normalizedComparableCode(queryCode)) {
    throw new Error('MetaTube 影片详情番号与查询番号不一致')
  }

  const runtime = optionalNumber(detail.runtime, 'runtime')
  if (runtime !== undefined && (!Number.isInteger(runtime) || runtime <= 0)) {
    throw new Error('MetaTube 字段 runtime 必须为正整数分钟')
  }
  const score = optionalNumber(detail.score, 'score')
  const actors = cleanStrings(stringArray(detail.actors, 'actors'), ctx.helpers)
  const genres = cleanStrings(stringArray(detail.genres, 'genres'), ctx.helpers)
  const previewImages = stringArray(detail.preview_images, 'preview_images')
    .map(validHttpUrl)
    .filter(Boolean)
  if (previewImages.length > MAX_SAMPLE_IMAGES) {
    console.warn(`MetaTube 样张超过 ${MAX_SAMPLE_IMAGES} 张，已截断`)
  }

  const imagePath = `/v1/images/primary/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`
  const result = {
    code: normalizedResultCode(queryCode),
    title: ctx.helpers.normalizeText(title),
    summary: optionalText(detail.summary, 'summary', ctx.helpers),
    coverUrl: ctx.service.publicUrl(imagePath, { quality: 90 }),
    releaseDate: validDate(detail.release_date),
    maker: optionalText(detail.maker, 'maker', ctx.helpers),
    publisher: optionalText(detail.label, 'label', ctx.helpers),
    series: optionalText(detail.series, 'series', ctx.helpers),
    director: optionalText(detail.director, 'director', ctx.helpers),
    durationSeconds: runtime === undefined ? undefined : runtime * 60,
    actresses: actors.map((name) => ({ name, gender: 'female' })),
    tags: genres,
    sourceUrl: optionalHttpUrl(detail.homepage, 'homepage'),
    ratingAverage: score !== undefined && score > 0 && score <= 5
      ? Math.round(score * 10) / 10
      : undefined,
    sampleImageUrls: previewImages.slice(0, MAX_SAMPLE_IMAGES).map((url) =>
      ctx.service.publicUrl(imagePath, {
        url,
        ratio: 0,
        pos: 0,
        auto: false,
        quality: 90
      })
    )
  }

  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => {
      if (value === undefined || value === null || value === '') return false
      return !Array.isArray(value) || value.length > 0
    })
  )
}

module.exports = {
  async parseVideo(ctx) {
    if (!ctx.service) throw new Error('请先配置 MetaTube 服务端地址')
    const queryCode = requiredText(ctx.code, 'query code')
    let searchPayload
    try {
      searchPayload = await ctx.service.getJson('/v1/movies/search', {
        query: { q: queryCode, fallback: true }
      })
    } catch (error) {
      if (error && error.status === 404) return []
      throw error
    }

    const searchData = envelopeData(searchPayload, '影片搜索')
    if (!Array.isArray(searchData)) throw new Error('MetaTube 影片搜索 data 必须为数组')
    const comparableQuery = normalizedComparableCode(queryCode)
    const seen = new Set()
    const exact = []
    for (const rawItem of searchData) {
      const item = objectValue(rawItem, '影片搜索项')
      const id = requiredText(item.id, 'id')
      const provider = requiredText(item.provider, 'provider')
      const number = requiredText(item.number, 'number')
      if (normalizedComparableCode(number) !== comparableQuery) continue
      const key = `${provider}\u0000${id}`
      if (seen.has(key)) continue
      seen.add(key)
      exact.push({ id, provider })
    }

    if (exact.length === 0) return []
    if (exact.length > MAX_EXACT_CANDIDATES) {
      throw new Error(`MetaTube 返回超过 ${MAX_EXACT_CANDIDATES} 个精确候选，请缩小服务端 Provider 范围`)
    }

    return mapLimit(exact, DETAIL_CONCURRENCY, async (identity) => {
      const payload = await ctx.service.getJson(
        `/v1/movies/${encodeURIComponent(identity.provider)}/${encodeURIComponent(identity.id)}`,
        { query: { lazy: true } }
      )
      return mapDetail(ctx, queryCode, identity, payload)
    })
  }
}
