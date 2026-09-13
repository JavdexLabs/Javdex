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

export function createMemoryPlaylistImportCatalogLookup(): PlaylistImportCatalogLookup & {
  ingestCodes(catalog: CatalogBackend, codes: Array<string | null | undefined>): Promise<void>
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
          ingest({
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
    }
  }
}
