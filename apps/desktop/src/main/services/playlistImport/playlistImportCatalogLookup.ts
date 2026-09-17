import { createHash } from 'node:crypto'
import { normalizeVideoCode } from '@shared/videoCode'
import { normalizeClassificationName } from '@shared/classificationNameNormalization'
import { normalizeRelatedLinkUrl } from '@shared/relatedLinkUrl'
import type { CatalogBackend } from '../../application/catalogBackend'

export interface PlaylistImportCatalogVideoRecord {
  videoId: number
  code: string
  title: string | null
  publisher: string | null
  publisherOrganizationId: number | null
  releaseDate: string | null
  libraryIds: number[]
  libraryNames: string[]
  relatedUrls: string[]
  relatedLinks: Array<{ label: string; url: string }>
  sources: Array<{ source: string; externalCode: string | null; url: string | null }>
  resourceKinds: string[]
}

export interface PlaylistImportCatalogLookup {
  readonly writes: 'sql' | 'catalog'
  videoById(id: number): PlaylistImportCatalogVideoRecord | null
  videosByCode(code: string): PlaylistImportCatalogVideoRecord[]
  videosByDetailUrl(normalizedDetailUrl: string): PlaylistImportCatalogVideoRecord[]
  videosByIds(videoIds: number[]): PlaylistImportCatalogVideoRecord[]
  videosBySourceIdentity(identity: {
    source?: string
    externalCode?: string
    sourceUrl?: string
  }): PlaylistImportCatalogVideoRecord[]
  videosByPublisherCodeRelease(
    normalizedPublisher: string,
    code: string,
    releaseDate: string
  ): PlaylistImportCatalogVideoRecord[]
  playlistName?(playlistId: number): string | null
  rememberPlaylist?(playlistId: number, name: string): void
  ingestCodes?(catalog: CatalogBackend, codes: Array<string | null | undefined>): Promise<void>
  ingestSourceIdentity?(
    catalog: CatalogBackend,
    identity: { source?: string; externalCode?: string; sourceUrl?: string }
  ): Promise<void>
}

function normalizedCode(code: string): string {
  return normalizeVideoCode(code)
}

function relatedUrl(raw: string): string | null {
  try {
    return normalizeRelatedLinkUrl(raw)
  } catch {
    return null
  }
}

export function catalogIdentityRevision(record: PlaylistImportCatalogVideoRecord): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        code: normalizedCode(record.code),
        publisherOrganizationId: record.publisherOrganizationId,
        releaseDate: record.releaseDate,
        libraryIds: record.libraryIds,
        relatedUrls: record.relatedUrls,
        sources: record.sources
      })
    )
    .digest('hex')
}

const SOURCE_LOOKUP_PAGE_SIZE = 50

async function listAllCatalogSourceItems(
  catalog: CatalogBackend,
  query: { source: string; externalCode?: string; url?: string }
): Promise<Array<{
  videoId: number
  code?: string
  sources?: PlaylistImportCatalogVideoRecord['sources']
}>> {
  const items: Array<{
    videoId: number
    code?: string
    sources?: PlaylistImportCatalogVideoRecord['sources']
  }> = []
  let offset = 0
  for (;;) {
    const page = (await catalog.queries.listVideoSources({
      ...query,
      limit: SOURCE_LOOKUP_PAGE_SIZE,
      offset
    })) as {
      items?: Array<{
        videoId: number
        code?: string
        sources?: PlaylistImportCatalogVideoRecord['sources']
      }>
      total?: number
    }
    if (!page || !Array.isArray(page.items)) {
      throw new Error('来源查询响应无效。')
    }
    items.push(...page.items)
    const nextOffset = offset + page.items.length
    if (
      page.items.length === 0 ||
      page.items.length < SOURCE_LOOKUP_PAGE_SIZE ||
      (typeof page.total === 'number' && nextOffset >= page.total)
    ) {
      break
    }
    if (nextOffset > 1_000_000) throw new Error('来源查询结果超过支持范围。')
    offset = nextOffset
  }
  return items
}

export function createMemoryPlaylistImportCatalogLookup(): PlaylistImportCatalogLookup & {
  ingestCodes(catalog: CatalogBackend, codes: Array<string | null | undefined>): Promise<void>
  ingestSourceIdentity(
    catalog: CatalogBackend,
    identity: { source?: string; externalCode?: string; sourceUrl?: string }
  ): Promise<void>
} {
  const byId = new Map<number, PlaylistImportCatalogVideoRecord>()
  const playlistNames = new Map<number, string>()

  const all = (): PlaylistImportCatalogVideoRecord[] => [...byId.values()]

  const ingest = (record: PlaylistImportCatalogVideoRecord): void => {
    byId.set(record.videoId, record)
  }

  return {
    writes: 'catalog',
    videoById(id) {
      return byId.get(id) ?? null
    },
    videosByCode(code) {
      const expected = normalizedCode(code)
      return all()
        .filter((video) => normalizedCode(video.code) === expected)
        .sort((left, right) => left.videoId - right.videoId)
    },
    videosByDetailUrl(normalizedDetailUrl) {
      return all()
        .filter((video) => video.relatedUrls.includes(normalizedDetailUrl))
        .sort((left, right) => left.videoId - right.videoId)
    },
    videosByIds(videoIds) {
      return [...new Set(videoIds)]
        .sort((left, right) => left - right)
        .flatMap((id) => {
          const video = byId.get(id)
          return video ? [video] : []
        })
    },
    videosBySourceIdentity(identity) {
      const source = identity.source?.trim()
      if (!source) return []
      const ids: number[] = []
      if (identity.externalCode?.trim()) {
        const external = identity.externalCode.trim().toUpperCase()
        for (const video of all()) {
          if (
            video.sources.some(
              (entry) =>
                entry.source.trim().toLowerCase() === source.toLowerCase() &&
                (entry.externalCode ?? '').trim().toUpperCase() === external
            )
          ) {
            ids.push(video.videoId)
          }
        }
      }
      if (identity.sourceUrl?.trim()) {
        const normalized = relatedUrl(identity.sourceUrl)
        if (normalized) {
          for (const video of all()) {
            if (
              video.sources.some((entry) => {
                if (entry.source.trim().toLowerCase() !== source.toLowerCase() || !entry.url) {
                  return false
                }
                return relatedUrl(entry.url) === normalized
              })
            ) {
              ids.push(video.videoId)
            }
          }
        }
      }
      return this.videosByIds(ids)
    },
    videosByPublisherCodeRelease(normalizedPublisher, code, releaseDate) {
      const expected = normalizedCode(code)
      return all()
        .filter((video) => {
          if (normalizedCode(video.code) !== expected || video.releaseDate !== releaseDate) {
            return false
          }
          if (!video.publisher) return false
          try {
            return normalizeClassificationName(video.publisher) === normalizedPublisher
          } catch {
            return false
          }
        })
        .sort((left, right) => left.videoId - right.videoId)
    },
    playlistName(playlistId) {
      return playlistNames.get(playlistId) ?? null
    },
    rememberPlaylist(playlistId, name) {
      playlistNames.set(playlistId, name)
    },
    async ingestCodes(catalog, codes) {
      const unique = [
        ...new Set(
          codes
            .filter((value): value is string => Boolean(value && value.trim()))
            .map((value) => normalizedCode(value))
        )
      ]
      const details: PlaylistImportCatalogVideoRecord[] = []
      for (const code of unique) {
        const page = (await catalog.queries.listVideos({
          scope: { kind: 'all' },
          query: { search: code, sortBy: 'code', limit: 200 }
        })) as { items?: Array<{ id: number; code?: string }> }
        if (!page || !Array.isArray(page.items)) {
          throw new Error('影片列表响应无效。')
        }
        for (const item of page.items) {
          if (!item.code || normalizedCode(item.code) !== code) continue
          const detail = (await catalog.queries.getVideo({
            scope: { kind: 'all' },
            videoId: item.id
          })) as {
            id: number
            code: string
            title?: string | null
            publisher?: string | null
            publisher_organization_id?: number | null
            release_date?: string | null
            libraries?: Array<{ libraryId: number; name: string }>
            links?: Array<{ label: string; url: string }>
            resource_kinds?: string[]
            resources?: Array<{ kind?: string }>
          } | null
          if (!detail) continue
          const relatedLinks = (detail.links ?? []).map((link) => ({
            label: link.label,
            url: link.url
          }))
          details.push({
            videoId: detail.id,
            code: detail.code,
            title: detail.title ?? null,
            publisher: detail.publisher ?? null,
            publisherOrganizationId: detail.publisher_organization_id ?? null,
            releaseDate: detail.release_date ?? null,
            libraryIds: (detail.libraries ?? []).map((library) => library.libraryId),
            libraryNames: (detail.libraries ?? []).map((library) => library.name),
            relatedUrls: relatedLinks
              .map((link) => relatedUrl(link.url))
              .filter((url): url is string => Boolean(url)),
            relatedLinks,
            sources: [],
            resourceKinds: [
              ...new Set([
                ...(detail.resource_kinds ?? []),
                ...(detail.resources ?? [])
                  .map((resource) => resource.kind)
                  .filter((kind): kind is string => Boolean(kind))
              ])
            ]
          })
        }
      }
      const sourcesByVideo = await loadCatalogSources(
        catalog,
        details.map((detail) => detail.videoId)
      )
      for (const detail of details) {
        ingest({
          ...detail,
          sources: sourcesByVideo.get(detail.videoId) ?? []
        })
      }
    },
    async ingestSourceIdentity(catalog, identity) {
      const source = identity.source?.trim()
      if (!source) return
      const queries = [
        ...(identity.externalCode?.trim()
          ? [{ source, externalCode: identity.externalCode.trim(), limit: 50, offset: 0 }]
          : []),
        ...(identity.sourceUrl?.trim()
          ? [{ source, url: identity.sourceUrl.trim(), limit: 50, offset: 0 }]
          : [])
      ]
      if (queries.length === 0) return

      const mergeSources = (
        current: PlaylistImportCatalogVideoRecord['sources'],
        incoming: PlaylistImportCatalogVideoRecord['sources']
      ): PlaylistImportCatalogVideoRecord['sources'] => {
        const merged = [...current]
        for (const next of incoming) {
          const duplicate = merged.some((entry) =>
            entry.source.trim().toLowerCase() === next.source.trim().toLowerCase() &&
            (entry.externalCode ?? '').trim().toUpperCase() ===
              (next.externalCode ?? '').trim().toUpperCase() &&
            (entry.url ?? '').trim() === (next.url ?? '').trim()
          )
          if (!duplicate) merged.push(next)
        }
        return merged
      }

      for (const query of queries) {
        const items = await listAllCatalogSourceItems(catalog, query)
        for (const item of items) {
          const sources = item.sources ?? []
          const existing = byId.get(item.videoId)
          if (existing) {
            byId.set(item.videoId, {
              ...existing,
              sources: mergeSources(existing.sources, sources)
            })
            continue
          }
          ingest({
            videoId: item.videoId,
            code: item.code ?? '',
            title: null,
            publisher: null,
            publisherOrganizationId: null,
            releaseDate: null,
            libraryIds: [],
            libraryNames: [],
            relatedUrls: [],
            relatedLinks: [],
            sources,
            resourceKinds: []
          })
        }
      }
    }
  }
}

async function loadCatalogSources(
  catalog: CatalogBackend,
  videoIds: number[]
): Promise<Map<number, PlaylistImportCatalogVideoRecord['sources']>> {
  const sourcesByVideo = new Map<number, PlaylistImportCatalogVideoRecord['sources']>()
  const unique = [...new Set(videoIds)]
  for (let index = 0; index < unique.length; index += 200) {
    const chunk = unique.slice(index, index + 200)
    const page = (await catalog.queries.listVideoSources({
      videoIds: chunk,
      limit: 200,
      offset: 0
    })) as {
      items?: Array<{ videoId: number; sources?: PlaylistImportCatalogVideoRecord['sources'] }>
    }
    if (!page || !Array.isArray(page.items)) {
      throw new Error('来源查询响应无效。')
    }
    for (const item of page.items) {
      sourcesByVideo.set(item.videoId, item.sources ?? [])
    }
  }
  return sourcesByVideo
}
