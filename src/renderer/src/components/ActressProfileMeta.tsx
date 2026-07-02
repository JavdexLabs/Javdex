import { useMemo } from 'react'
import {
  BLOOD_TYPE_OPTIONS,
  NATIONALITY_OPTIONS,
  ZODIAC_OPTIONS
} from '@shared/actressProfileOptions'
import { formatCupSizeDisplay, normalizeCupSize } from '@shared/cupSizeUtils'
import type { ActressDetail } from '@shared/types'

type MetaItem = { key: string; label: string; value: string }

function isBlank(value: string | null | undefined): boolean {
  return !value?.trim()
}

function normalizeNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '')
}

function labelForStoredOption(
  options: Array<{ value: string; label: string }>,
  value: string
): string {
  return options.find((item) => item.value === value)?.label ?? value
}

function computeAge(birthDate: string): number | null {
  const birth = new Date(birthDate)
  if (Number.isNaN(birth.getTime())) return null
  const today = new Date()
  let age = today.getFullYear() - birth.getFullYear()
  const monthDelta = today.getMonth() - birth.getMonth()
  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < birth.getDate())) {
    age -= 1
  }
  return age >= 0 && age < 130 ? age : null
}

function formatMeasurements(
  bust: number | null,
  waist: number | null,
  hip: number | null
): string | null {
  const parts: string[] = []
  if (bust != null) parts.push(`B${bust}`)
  if (waist != null) parts.push(`W${waist}`)
  if (hip != null) parts.push(`H${hip}`)
  return parts.length > 0 ? parts.join(' / ') : null
}

function formatTimestamp(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const date = new Date(trimmed)
  if (Number.isNaN(date.getTime())) return trimmed
  return date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
}

function findTypedName(actress: ActressDetail, type: string): string | null {
  const row = actress.names.find((item) => item.type === type)
  const name = row?.name.trim()
  return name || null
}

function buildActressMetaSections(actress: ActressDetail): Array<{
  id: string
  title: string
  items: MetaItem[]
}> {
  const knownNames = new Set(
    [actress.main_name, actress.name_zh, actress.name_en, ...actress.aliases]
      .filter(Boolean)
      .map((name) => normalizeNameKey(String(name)))
  )

  const nativeName = findTypedName(actress, 'native')
  const romajiName = findTypedName(actress, 'romaji')
  const extraNative =
    nativeName && !knownNames.has(normalizeNameKey(nativeName)) ? nativeName : null
  if (extraNative) knownNames.add(normalizeNameKey(extraNative))
  const extraRomaji =
    romajiName && !knownNames.has(normalizeNameKey(romajiName)) ? romajiName : null

  const identity: MetaItem[] = []
  if (!isBlank(actress.name_zh) && actress.name_zh !== actress.main_name) {
    identity.push({ key: 'name_zh', label: '中文名', value: actress.name_zh!.trim() })
  }
  if (!isBlank(actress.name_en) && actress.name_en !== actress.main_name) {
    identity.push({ key: 'name_en', label: '英文名', value: actress.name_en!.trim() })
  }
  if (extraNative) {
    identity.push({ key: 'native', label: '日文名', value: extraNative })
  }
  if (extraRomaji) {
    identity.push({ key: 'romaji', label: '罗马字', value: extraRomaji })
  }
  if (actress.gender === 'male') {
    identity.push({ key: 'gender', label: '性别', value: '男优' })
  }
  if (!isBlank(actress.birth_date)) {
    const age = computeAge(actress.birth_date!.trim())
    identity.push({
      key: 'birth_date',
      label: '生日',
      value: age != null ? `${actress.birth_date}（${age} 岁）` : actress.birth_date!.trim()
    })
  }
  if (!isBlank(actress.debut_date)) {
    identity.push({ key: 'debut_date', label: '出道', value: actress.debut_date!.trim() })
  }
  if (!isBlank(actress.nationality)) {
    identity.push({
      key: 'nationality',
      label: '国籍',
      value: labelForStoredOption(NATIONALITY_OPTIONS, actress.nationality!.trim())
    })
  }

  const physique: MetaItem[] = []
  if (actress.height_cm != null) {
    physique.push({ key: 'height', label: '身高', value: `${actress.height_cm} cm` })
  }
  if (actress.gender !== 'male') {
    const measurements = formatMeasurements(actress.bust_cm, actress.waist_cm, actress.hip_cm)
    if (measurements) {
      physique.push({ key: 'measurements', label: '三围', value: measurements })
    }
    if (normalizeCupSize(actress.cup_size)) {
      physique.push({
        key: 'cup_size',
        label: '罩杯',
        value: formatCupSizeDisplay(actress.cup_size)
      })
    }
  }

  const profile: MetaItem[] = []
  if (!isBlank(actress.blood_type)) {
    profile.push({
      key: 'blood_type',
      label: '血型',
      value: labelForStoredOption(BLOOD_TYPE_OPTIONS, actress.blood_type!.trim())
    })
  }
  if (!isBlank(actress.zodiac)) {
    profile.push({
      key: 'zodiac',
      label: '星座',
      value: labelForStoredOption(ZODIAC_OPTIONS, actress.zodiac!.trim())
    })
  }
  const scrapedAt = formatTimestamp(actress.last_scraped_at)
  if (scrapedAt) {
    profile.push({ key: 'last_scraped_at', label: '最近刮削', value: scrapedAt })
  }

  const sections: Array<{ id: string; title: string; items: MetaItem[] }> = []
  if (identity.length > 0) sections.push({ id: 'identity', title: '基本资料', items: identity })
  if (physique.length > 0) sections.push({ id: 'physique', title: '身体数据', items: physique })
  if (profile.length > 0) sections.push({ id: 'profile', title: '其他', items: profile })
  return sections
}

export function buildActressProfileSubtitle(actress: ActressDetail): string | null {
  const parts = [actress.name_zh, actress.name_en]
    .map((name) => name?.trim())
    .filter((name): name is string => Boolean(name && name !== actress.main_name))
  const unique = [...new Set(parts)]
  return unique.length > 0 ? unique.join(' · ') : null
}

export function buildActressProfileStats(actress: ActressDetail): string[] {
  const stats: string[] = [`${actress.videos.length} 部`]
  if (actress.height_cm != null) stats.push(`${actress.height_cm} cm`)
  if (!isBlank(actress.birth_date)) {
    const age = computeAge(actress.birth_date!.trim())
    if (age != null) stats.push(`${age} 岁`)
  }
  if (actress.gender !== 'male' && normalizeCupSize(actress.cup_size)) {
    stats.push(formatCupSizeDisplay(actress.cup_size))
  }
  return stats
}

export default function ActressProfileMeta({
  actress
}: {
  actress: ActressDetail
}): JSX.Element | null {
  const sections = useMemo(() => buildActressMetaSections(actress), [actress])
  const aliases = actress.aliases.filter((alias) => alias.trim().length > 0)
  const summary = actress.profile_summary?.trim()
  const hasContent = sections.length > 0 || aliases.length > 0 || Boolean(summary)

  if (!hasContent) return null

  return (
    <div className="actress-profile-meta">
      {sections.length > 0 && (
        <div className="actress-profile-meta-sections">
          {sections.map((section) => (
            <section key={section.id} className="actress-profile-meta-section">
              <h2 className="actress-profile-meta-section-title">{section.title}</h2>
              <dl className="actress-profile-meta-grid">
                {section.items.map((item) => (
                  <div key={item.key} className="actress-profile-meta-item">
                    <dt>{item.label}</dt>
                    <dd>{item.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}

      {aliases.length > 0 && (
        <section className="actress-profile-aliases" aria-label="别名">
          <h2 className="actress-profile-meta-section-title">别名</h2>
          <div className="actress-profile-alias-list">
            {aliases.map((alias) => (
              <span key={alias} className="actress-profile-alias-chip">
                {alias}
              </span>
            ))}
          </div>
        </section>
      )}

      {summary && (
        <section className="actress-profile-summary" aria-label="简介">
          <h2 className="actress-profile-meta-section-title">简介</h2>
          <p>{summary}</p>
        </section>
      )}
    </div>
  )
}
