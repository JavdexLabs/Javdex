import type { ActressGender } from '@shared/actressTypes'
import type { NfoExportProfileId, NfoExportProfileOption } from '@shared/nfoExportTypes'
import {
  MAX_NFO_BYTES,
  NfoArtifactError,
  escapeNfoXml,
  normalizeNfoField,
  renderNfoElement
} from '../nfoArtifactCodec'

export interface NfoExportActor {
  name: string
  gender?: ActressGender
  thumbReference?: string
}

export interface NfoExportRating {
  source: string
  average: number
  count?: number
}

export interface NfoExportIdentity {
  source: string
  code: string
}

export interface NfoExportVideoDocument {
  code: string
  title?: string
  originalTitle?: string
  summary?: string
  releaseDate?: string
  maker?: string
  publisher?: string
  series?: string
  director?: string
  durationSeconds?: number
  tags: string[]
  actors: NfoExportActor[]
  ratings: NfoExportRating[]
  identities: NfoExportIdentity[]
  coverReference?: string
  landscapeReference?: string
  fanartReference?: string
}

interface ProfileDefinition extends NfoExportProfileOption {
  includeOriginalTitle: boolean
  includePublisher: boolean
  includeRatings: boolean
  includeActorGender: boolean
  tagsAsGenre: boolean
  includeExternalIdentities: boolean
  includeNum: boolean
  ratingSourceAliases?: Readonly<Record<string, string>>
}

const definitions: readonly ProfileDefinition[] = [
  {
    id: 'portable-v1',
    label: '通用 / Kodi',
    description: '稳定的 Kodi 电影 NFO 子集，也用于 VidHub、Nova、Zidoo、Stash 与 Serviio。',
    includeOriginalTitle: true,
    includePublisher: true,
    includeRatings: true,
    includeActorGender: true,
    tagsAsGenre: false,
    includeExternalIdentities: true,
    includeNum: true
  },
  {
    id: 'jellyfin-current',
    label: 'Jellyfin',
    description: 'Jellyfin 可读取的 Kodi NFO 字段与本地图片命名。',
    includeOriginalTitle: true,
    includePublisher: false,
    includeRatings: true,
    includeActorGender: false,
    tagsAsGenre: true,
    includeExternalIdentities: true,
    includeNum: false
  },
  {
    id: 'emby-kodi-conservative',
    label: 'Emby / Kodi 保守子集',
    description: '只写入 Emby 与 Kodi 都稳定接受的常用电影字段。',
    includeOriginalTitle: true,
    includePublisher: false,
    includeRatings: false,
    includeActorGender: false,
    tagsAsGenre: true,
    includeExternalIdentities: false,
    includeNum: false
  },
  {
    id: 'plex-nfo-1.43.1+',
    label: 'Plex NFO Agent（1.43.1+）',
    description: '面向 Plex 官方 NFO Agent 的本地电影元数据。',
    warning: '需要 PMS 1.43.1+ 和官方 NFO Agent；默认 Plex Movie Agent 不读取此 profile。',
    includeOriginalTitle: true,
    includePublisher: false,
    includeRatings: true,
    includeActorGender: false,
    tagsAsGenre: true,
    includeExternalIdentities: true,
    includeNum: false,
    ratingSourceAliases: {
      imdb: 'imdb',
      tmdb: 'themoviedb',
      themoviedb: 'themoviedb',
      tvdb: 'thetvdb',
      thetvdb: 'thetvdb'
    }
  },
  {
    id: 'infuse-current',
    label: 'Infuse',
    description: 'Infuse 本地 metadata 子集；封面使用与影片同名的图片。',
    warning: 'Infuse 需启用本地 metadata；UPnP 库不读取这些旁路文件。',
    includeOriginalTitle: false,
    includePublisher: false,
    includeRatings: false,
    includeActorGender: false,
    tagsAsGenre: true,
    includeExternalIdentities: false,
    includeNum: false
  }
]

export const NFO_EXPORT_PROFILES: readonly NfoExportProfileOption[] = definitions.map(
  ({ includeOriginalTitle: _a, includePublisher: _b, includeRatings: _c,
    includeActorGender: _d, tagsAsGenre: _e, includeExternalIdentities: _f,
    includeNum: _g, ratingSourceAliases: _h, ...option }) => option
)

export function getNfoExportProfile(id: NfoExportProfileId): NfoExportProfileOption {
  const profile = NFO_EXPORT_PROFILES.find((item) => item.id === id)
  if (!profile) throw new Error(`Unknown NFO export profile: ${id}`)
  return profile
}

export function listUnrepresentedNfoFields(
  profileId: NfoExportProfileId,
  document: NfoExportVideoDocument
): string[] {
  const profile = definitionFor(profileId)
  const fields: string[] = []
  if (!profile.includeOriginalTitle && document.originalTitle) fields.push('原始标题')
  if (!profile.includePublisher && document.publisher) fields.push('发行方')
  if (document.ratings.some((rating) => !supportsRating(profile, rating))) fields.push('评分')
  if (!profile.includeActorGender && document.actors.some((actor) => actor.gender)) {
    fields.push('演员性别')
  }
  const hasUnknownIdentity = document.identities.some(
    (identity) => !['imdb', 'tmdb', 'tvdb'].includes(identity.source.trim().toLowerCase())
  )
  if ((!profile.includeExternalIdentities && document.identities.length > 0) || hasUnknownIdentity) {
    fields.push('站点身份')
  }
  return fields
}

function definitionFor(id: NfoExportProfileId): ProfileDefinition {
  const profile = definitions.find((item) => item.id === id)
  if (!profile) throw new Error(`Unknown NFO export profile: ${id}`)
  return profile
}

function canonicalRatingSource(
  profile: ProfileDefinition,
  rating: NfoExportRating
): string | undefined {
  if (!profile.includeRatings) return undefined
  if (!profile.ratingSourceAliases) return rating.source
  return profile.ratingSourceAliases[rating.source.trim().toLowerCase()]
}

function supportsRating(profile: ProfileDefinition, rating: NfoExportRating): boolean {
  return canonicalRatingSource(profile, rating) != null
}

function representedRatings(
  profile: ProfileDefinition,
  ratings: readonly NfoExportRating[]
): NfoExportRating[] {
  const bySource = new Map<string, NfoExportRating>()
  for (const rating of ratings) {
    if (!Number.isFinite(rating.average)) continue
    const source = canonicalRatingSource(profile, rating)
    if (!source || bySource.has(source)) continue
    bySource.set(source, { ...rating, source })
  }
  return Array.from(bySource.values()).sort((a, b) => a.source.localeCompare(b.source, 'en'))
}

function uniqueSorted(values: readonly string[]): string[] {
  return Array.from(new Set(values.map(normalizeNfoField).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })
  )
}

export function renderNfoExportDocument(
  profileId: NfoExportProfileId,
  document: NfoExportVideoDocument
): Buffer {
  const profile = definitionFor(profileId)
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<movie>']
  lines.push(`  <uniqueid type="num" default="true">${escapeNfoXml(document.code)}</uniqueid>`)
  lines.push(renderNfoElement('id', document.code))
  if (profile.includeNum) lines.push(renderNfoElement('num', document.code))
  lines.push(renderNfoElement('title', document.title || document.code))
  if (profile.includeOriginalTitle && document.originalTitle) {
    lines.push(renderNfoElement('originaltitle', document.originalTitle))
  }
  if (document.summary) lines.push(renderNfoElement('plot', document.summary))
  if (document.releaseDate) lines.push(renderNfoElement('premiered', document.releaseDate))
  if (document.maker) lines.push(renderNfoElement('studio', document.maker))
  if (profile.includePublisher && document.publisher) {
    lines.push(renderNfoElement('publisher', document.publisher))
  }
  if (document.series) {
    lines.push('  <set>', renderNfoElement('name', document.series, '    '), '  </set>')
  }
  if (document.director) lines.push(renderNfoElement('director', document.director))
  if (document.durationSeconds != null && document.durationSeconds > 0) {
    lines.push(renderNfoElement('runtime', String(Math.round(document.durationSeconds / 60))))
  }
  if (profile.includeExternalIdentities) {
    for (const identity of document.identities
      .filter((item) => ['imdb', 'tmdb', 'tvdb'].includes(item.source.trim().toLowerCase()))
      .sort((a, b) =>
      `${a.source}:${a.code}`.localeCompare(`${b.source}:${b.code}`, 'en')
    )) {
      lines.push(`  <uniqueid type="${escapeNfoXml(identity.source.trim().toLowerCase())}">${escapeNfoXml(identity.code)}</uniqueid>`)
    }
  }
  if (profile.includeRatings) {
    const ratings = representedRatings(profile, document.ratings)
    if (ratings.length > 0) {
      lines.push('  <ratings>')
      ratings.forEach((rating, index) => {
        lines.push(`    <rating name="${escapeNfoXml(rating.source)}" max="5"${index === 0 ? ' default="true"' : ''}>`)
        lines.push(renderNfoElement('value', String(rating.average), '      '))
        if (rating.count != null) lines.push(renderNfoElement('votes', String(rating.count), '      '))
        lines.push('    </rating>')
      })
      lines.push('  </ratings>')
    }
  }
  for (const tag of uniqueSorted(document.tags)) {
    lines.push(renderNfoElement(profile.tagsAsGenre ? 'genre' : 'tag', tag))
  }
  for (const actor of [...document.actors].sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    lines.push('  <actor>', renderNfoElement('name', actor.name, '    '))
    if (profile.includeActorGender && actor.gender) lines.push(renderNfoElement('gender', actor.gender, '    '))
    if (actor.thumbReference) lines.push(renderNfoElement('thumb', actor.thumbReference, '    '))
    lines.push('  </actor>')
  }
  if (document.coverReference) {
    lines.push(`  <thumb aspect="poster">${escapeNfoXml(document.coverReference)}</thumb>`)
  }
  if (document.landscapeReference && ['portable-v1', 'jellyfin-current', 'emby-kodi-conservative'].includes(profileId)) {
    lines.push(`  <thumb aspect="landscape">${escapeNfoXml(document.landscapeReference)}</thumb>`)
  }
  if (document.fanartReference) {
    lines.push('  <fanart>')
    lines.push(renderNfoElement('thumb', document.fanartReference, '    '))
    lines.push('  </fanart>')
  }
  lines.push('</movie>', '')
  const result = Buffer.from(lines.join('\n'), 'utf8')
  if (result.byteLength > MAX_NFO_BYTES) throw new NfoArtifactError('too-large')
  return result
}

export function coverBasename(profileId: NfoExportProfileId, stem: string): string {
  return profileId === 'infuse-current' ? stem : `${stem}-poster`
}
