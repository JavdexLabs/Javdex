import type { ActressGender } from './types'

export type SelectOption = { value: string; label: string }

export const BLOOD_TYPE_OPTIONS: SelectOption[] = [
  { value: '', label: '—' },
  { value: 'A', label: 'A' },
  { value: 'B', label: 'B' },
  { value: 'AB', label: 'AB' },
  { value: 'O', label: 'O' }
]

export const CUP_SIZE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

export const ZODIAC_OPTIONS: SelectOption[] = [
  { value: '', label: '—' },
  { value: 'Aries', label: '白羊座' },
  { value: 'Taurus', label: '金牛座' },
  { value: 'Gemini', label: '双子座' },
  { value: 'Cancer', label: '巨蟹座' },
  { value: 'Leo', label: '狮子座' },
  { value: 'Virgo', label: '处女座' },
  { value: 'Libra', label: '天秤座' },
  { value: 'Scorpio', label: '天蝎座' },
  { value: 'Sagittarius', label: '射手座' },
  { value: 'Capricorn', label: '摩羯座' },
  { value: 'Aquarius', label: '水瓶座' },
  { value: 'Pisces', label: '双鱼座' }
]

export const NATIONALITY_OPTIONS: SelectOption[] = [
  { value: '', label: '—' },
  { value: 'Japan', label: '日本' },
  { value: 'China', label: '中国' },
  { value: 'Taiwan', label: '中国台湾' },
  { value: 'Korea', label: '韩国' },
  { value: 'USA', label: '美国' },
  { value: 'Thailand', label: '泰国' },
  { value: 'Philippines', label: '菲律宾' },
  { value: 'Vietnam', label: '越南' }
]

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Map stored date text to `<input type="date">` value when possible. */
export function toDateInputValue(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? ''
  return ISO_DATE_RE.test(trimmed) ? trimmed : ''
}

export function isIsoDate(value: string): boolean {
  return ISO_DATE_RE.test(value.trim())
}

/** Keep only non-negative integer digits, capped by length. */
export function filterPositiveInt(value: string, maxDigits = 3): string {
  return value.replace(/\D/g, '').slice(0, maxDigits)
}

/** Latin display / stage names. */
export function filterLatinName(value: string): string {
  return value.replace(/[^A-Za-z\s.'-]/g, '')
}

/** Chinese / Japanese display names. */
export function filterCjkName(value: string): string {
  return value.replace(/[^\u4e00-\u9fff\u3040-\u30ffー\s]/g, '')
}

/** Single cup letter A–Z. */
export function filterCupLetter(value: string): string {
  const match = value.toUpperCase().match(/[A-Z]/)
  return match ? match[0] : ''
}

export function withCurrentSelectOption(
  options: SelectOption[],
  current: string | null | undefined
): SelectOption[] {
  const value = current?.trim() ?? ''
  if (!value || options.some((opt) => opt.value === value)) return options
  return [{ value, label: value }, ...options]
}

/** Unknown gender is treated as female for merge compatibility. */
export function actressMergeGenderGroup(
  gender: ActressGender | null | undefined
): ActressGender {
  return gender === 'male' ? 'male' : 'female'
}

export function canMergeActressGenders(
  a: ActressGender | null | undefined,
  b: ActressGender | null | undefined
): boolean {
  return actressMergeGenderGroup(a) === actressMergeGenderGroup(b)
}

export function actressGenderMergeLabel(gender: ActressGender | null | undefined): string {
  return actressMergeGenderGroup(gender) === 'male' ? '男优' : '女优'
}

export type ActressScrapeMatchNameKind = 'main' | 'alias' | 'name_zh' | 'name_en'

export interface ActressScrapeMatchNameOption {
  value: string
  label: string
  kind: ActressScrapeMatchNameKind
}

function normalizeActressMatchNameKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Build deduped scrape query names: main, zh, en, then aliases. */
export function buildActressScrapeMatchNameOptions(actress: {
  main_name: string
  name_zh: string | null
  name_en: string | null
  aliases: string[]
}): ActressScrapeMatchNameOption[] {
  const options: ActressScrapeMatchNameOption[] = []
  const seen = new Set<string>()

  const push = (option: ActressScrapeMatchNameOption): void => {
    const key = normalizeActressMatchNameKey(option.value)
    if (!key || seen.has(key)) return
    seen.add(key)
    options.push(option)
  }

  push({ value: actress.main_name, label: actress.main_name, kind: 'main' })

  const nameZh = actress.name_zh?.trim()
  if (nameZh) {
    push({ value: nameZh, label: nameZh, kind: 'name_zh' })
  }

  const nameEn = actress.name_en?.trim()
  if (nameEn) {
    push({ value: nameEn, label: nameEn, kind: 'name_en' })
  }

  for (const alias of actress.aliases) {
    const trimmed = alias.trim()
    if (!trimmed) continue
    push({ value: trimmed, label: trimmed, kind: 'alias' })
  }

  return options
}

export function formatActressScrapeMatchNameLabel(opt: ActressScrapeMatchNameOption): string {
  switch (opt.kind) {
    case 'main':
      return `主名 · ${opt.label}`
    case 'name_zh':
      return `中文名 · ${opt.label}`
    case 'name_en':
      return `英文名 · ${opt.label}`
    case 'alias':
      return `别名 · ${opt.label}`
  }
}
