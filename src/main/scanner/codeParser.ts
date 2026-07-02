// 番号 (video code) extractor — layered patterns (javinizer-go matcher inspired).

const NOISE_PATTERNS: RegExp[] = [
  /\b[a-z0-9][-a-z0-9]*\.(?:com|net|org|xxx|ws|tv|cc|me|io|jp|cn|info|biz|top|site|xyz|live|vip)\b/gi,
  /\[[^\]]*\]/g,
  /【[^】]*】/g,
  /\([^)]*\)/g,
  /（[^）]*）/g,
  /\b\d{3,4}p\b/gi,
  /\b(4k|8k|uhd|hd|fhd|hevc|x265|x264|h264|h265|aac|web-?dl|bluray|bdrip|dvdrip)\b/gi,
  /[@＠][^\s.\-_]+/g,
  /\b(uncensored|無修正|无修正|leak|leaked|流出|破解|无码|無碼|有码|有碼|moodyz)\b/gi,
  /[-_](c|ch|hb|sub|chs|cht|gg5|whole|full)\b/gi,
  /中文字幕|字幕|高清|无水印|無水印/g
]

/** DMM content-id style: h_1472smkcx003 */
const RE_DMM_H = /\b(h_\d+[a-z0-9]+\d+)\b/i

/** Uncensored date IDs: 020326_001-1PON, 123025-001-CARIB */
const RE_DATE_UNCENSORED = /\b(\d{6})[-_](\d{2,3})-(1PON|10MU|CARIB)\b/i

/** FC2-PPV-123456 */
const RE_FC2 = /\bFC2[-_\s]*(?:PPV[-_\s]*)?(\d{6,7})\b/i

/** HEYZO-1234 */
const RE_HEYZO = /\b(HEYZO)[-_\s]*(\d{3,5})\b/i

/** 規格品番: ADV-R0484 */
const RE_RISAN_LETTER = /\b([A-Za-z]{2,4})-([A-Za-z])(\d{3,5})\b/

/** 規格品番: ADV-SR0196 */
const RE_RISAN_MULTI = /\b([A-Za-z]{2,4})-([A-Za-z]{1,3})(\d{3,5})\b/

/** Long prefix: ADVVSR-486 */
const RE_LONG_PREFIX = /\b([A-Za-z]{4,6})-(\d{2,5})(?:[A-Za-z])?\b/

/** Standard: ABC-123, T28-581, AOZ-308Z (hyphen/underscore/space before digits) */
const RE_STANDARD =
  /\b([A-Za-z][A-Za-z0-9]{0,5}|T\d{2,3})[-_\s](\d{2,5})([A-Za-z])?\b/g

interface CodeMatch {
  code: string
  index: number
  score: number
}

function stripNoise(name: string): string {
  let out = name
  for (const p of NOISE_PATTERNS) {
    out = out.replace(p, ' ')
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** Full normalize for generic patterns; breaks h_ / date_ ids — use stripNoise for those. */
function denoise(name: string): string {
  return stripNoise(name).replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function isPlausibleStandard(label: string, num: string): boolean {
  if (label.length < 2) return false
  if (/^[A-Z]\d$/.test(label)) return false
  if (/^0+$/.test(num)) return false
  if (/^[A-Z]+\d+$/.test(label) && label.length <= 4) return true
  if (/[0-9]/.test(label) && num.length < 3) return false
  if (/[0-9]/.test(label)) return false
  return true
}

function scoreStandard(label: string, num: string, index: number): number {
  let score = num.length * 10 + label.length * 2 + index * 0.01
  if (/^[A-Z]+$/.test(label)) score += 8
  if (label.length >= 3) score += 4
  return score
}

function findBestStandardCode(cleaned: string): string | null {
  RE_STANDARD.lastIndex = 0
  let best: CodeMatch | null = null

  for (const m of cleaned.matchAll(RE_STANDARD)) {
    const label = m[1].toUpperCase()
    const num = m[2]
    if (!isPlausibleStandard(label, num)) continue

    const fullCode = `${label}-${num}${m[3] ? m[3].toUpperCase() : ''}`
    const score = scoreStandard(label, num, m.index ?? 0)
    if (!best || score > best.score) {
      best = { code: fullCode, index: m.index ?? 0, score }
    }
  }

  return best?.code ?? null
}

function tryRisanCodes(cleaned: string): string | null {
  const m1 = cleaned.match(RE_RISAN_LETTER)
  if (m1) return `${m1[1].toUpperCase()}-${m1[2].toUpperCase()}${m1[3]}`

  const m2 = cleaned.match(RE_RISAN_MULTI)
  if (m2) return `${m2[1].toUpperCase()}-${m2[2].toUpperCase()}${m2[3]}`

  return null
}

function parseCleaned(cleaned: string): string | null {
  const h = cleaned.match(RE_DMM_H)
  if (h) return h[1].toUpperCase()

  const date = cleaned.match(RE_DATE_UNCENSORED)
  if (date) return `${date[1]}_${date[2]}-${date[3].toUpperCase()}`

  const fc2 = cleaned.match(RE_FC2)
  if (fc2) return `FC2-${fc2[1]}`

  const heyzo = cleaned.match(RE_HEYZO)
  if (heyzo) return `HEYZO-${heyzo[2]}`

  const risan = tryRisanCodes(cleaned)
  if (risan) return risan

  const longP = cleaned.match(RE_LONG_PREFIX)
  if (longP) return `${longP[1].toUpperCase()}-${longP[2]}`

  const standard = findBestStandardCode(cleaned)
  if (standard) return standard

  return null
}

/**
 * Parse a filename (without extension) into a standard code, or null.
 */
function parseUnderscoreSensitive(cleaned: string): string | null {
  const h = cleaned.match(RE_DMM_H)
  if (h) return h[1].toUpperCase()

  const date = cleaned.match(RE_DATE_UNCENSORED)
  if (date) return `${date[1]}_${date[2]}-${date[3].toUpperCase()}`

  return null
}

export function parseCode(filenameNoExt: string): string | null {
  const at = filenameNoExt.lastIndexOf('@')
  if (at >= 0) {
    const afterAt = stripNoise(filenameNoExt.slice(at + 1))
    const fromAt = parseUnderscoreSensitive(afterAt) ?? parseCleaned(denoise(afterAt))
    if (fromAt) return fromAt
  }

  const light = stripNoise(filenameNoExt)
  return parseUnderscoreSensitive(light) ?? parseCleaned(denoise(filenameNoExt))
}

export const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.wmv', '.mov', '.ts', '.m4v', '.flv']

export function isVideoFile(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))
}
