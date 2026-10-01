import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { normalizeVideoCode } from '@shared/videoCode'
import { normalizeClassificationName } from '@shared/classificationNameNormalization'
import { normalizePlaylistImportUrl } from './playlistImportUrl'
import { catalogIdentityRevision, type PlaylistImportCatalogLookup, type PlaylistImportCatalogVideoRecord } from './playlistImportCatalogLookup'

export interface CanonicalDetailIdentity {
  detailUrl: string
  listCode?: string
  detailCode?: string
  codeConflict?: boolean
  publisher?: string
  releaseDate?: string
  source?: string
  externalCode?: string
  sourceUrl?: string
  strongMatchVideoId?: number
  strongSignalConflict: boolean
  strongSignalMismatch: boolean
}

export interface GlobalIdentityCandidate {
  videoId: number
  code: string
  libraryIds: number[]
  publisherOrganizationId: number | null
  releaseDate: string | null
  identityRevision: string
}

interface IdentityPlan {
  state: 'planned-reuse' | 'planned-create' | 'needs-user' | 'failed'
  resolutionKind: 'business-identity' | 'direct-code' | 'target-library-tiebreak' | 'create-no-match' | 'user-existing' | null
  videoId: number | null
  errorCode: string | null
}

/** The same automatic choice is used when planning and validating a preview. */
function automaticReuse(candidates: GlobalIdentityCandidate[], identity: CanonicalDetailIdentity | null, targetLibraryId: number): Pick<IdentityPlan, 'resolutionKind' | 'videoId'> | null {
  if (identity?.codeConflict || identity?.strongSignalConflict || identity?.strongSignalMismatch) return null
  if (identity?.strongMatchVideoId != null) {
    return { resolutionKind: 'business-identity', videoId: identity.strongMatchVideoId }
  }
  if (candidates.length === 1) return { resolutionKind: 'direct-code', videoId: candidates[0].videoId }
  const targetMatches = candidates.filter(candidate => candidate.libraryIds.includes(targetLibraryId))
  if (candidates.length > 1 && targetMatches.length === 1) {
    return { resolutionKind: 'target-library-tiebreak', videoId: targetMatches[0].videoId }
  }
  return null
}

interface GlobalIdentityVideoRow {
  id: number
  code: string
  publisher_organization_id: number | null
  release_date: string | null
}

interface IdentityPreviewItem {
  id: number
  revision: number
  normalized_code: string | null
  title: string | null
  detail_url: string
  normalized_detail_url: string
  state: string
  resolution_kind: string | null
  resolved_video_id: number | null
  candidate_snapshot_json: string | null
  detail_identity_json: string | null
  error_code: string | null
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function isMissingCatalogTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no such table: (videos|playlists|media_libraries|video_links|video_sources|library_video_memberships|playlist_video|organizations|organization_name_ownership|video_resources)\b/i.test(
    message
  )
}

/** Owns candidate evidence and preview validity; never advances jobs or writes catalog data. */
export class PlaylistImportIdentity {
  constructor(private readonly database: Database.Database, private readonly catalogLookup?: PlaylistImportCatalogLookup) {}

  findCandidates(input: {
    codes: Array<string | null>
    detailUrl?: string
    identity?: Record<string, unknown>
  }): GlobalIdentityCandidate[] {
    const identity = input.identity ?? {}
    return this.mergeGlobalIdentityCandidates(
      this.globalCodeCandidatesForCodes(input.codes),
      input.detailUrl ? this.globalDetailUrlCandidates(input.detailUrl) : [],
      this.globalSourceIdentityCandidates({
        ...(typeof identity.source === 'string' ? { source: identity.source } : {}),
        ...(typeof identity.externalCode === 'string' ? { externalCode: identity.externalCode } : {}),
        ...(typeof identity.sourceUrl === 'string' ? { sourceUrl: identity.sourceUrl } : {})
      })
    )
  }

  planDetail(input: {
    listCode: string | null
    detailCode: string | null
    detailUrl: string
    identity: Record<string, unknown>
    targetLibraryId: number
    autoCreate: boolean
  }): IdentityPlan & { code: string | null; candidates: GlobalIdentityCandidate[]; identity: CanonicalDetailIdentity } {
    const code = input.listCode ?? input.detailCode
    const codeConflict = Boolean(input.listCode && input.detailCode && input.listCode !== input.detailCode)
    const candidates = this.findCandidates({ ...input, codes: codeConflict ? [input.listCode, input.detailCode] : [code] })
    const identity = this.canonicalDetailIdentity({ ...input, code, candidates })
    if (codeConflict) {
      Object.assign(identity, { listCode: input.listCode, detailCode: input.detailCode, codeConflict: true, strongSignalConflict: true })
    }
    let plan: IdentityPlan = { state: 'needs-user', resolutionKind: 'user-existing', videoId: null, errorCode: null }
    if (!codeConflict && candidates.length === 0 && code) {
      plan = input.autoCreate
        ? { state: 'planned-create', resolutionKind: 'create-no-match', videoId: null, errorCode: null }
        : { state: 'failed', resolutionKind: null, videoId: null, errorCode: 'AUTO_CREATE_DISABLED' }
    } else {
      const reuse = automaticReuse(candidates, identity, input.targetLibraryId)
      if (reuse) plan = { ...reuse, state: 'planned-reuse', errorCode: null }
    }
    return { ...plan, code, candidates, identity }
  }

  private sqlVideoIdsByDetailUrl(normalizedDetailUrl: string): number[] {
    try {
      return (this.database.prepare(
        'SELECT video_id FROM video_links WHERE normalized_url = ? ORDER BY video_id'
      ).all(normalizedDetailUrl) as Array<{ video_id: number }>).map((row) => row.video_id)
    } catch (error) {
      if (isMissingCatalogTable(error)) return []
      throw error
    }
  }

  private sqlVideoIdsBySourceCode(source: string, externalCode: string): number[] {
    try {
      return (this.database.prepare(
        `SELECT video_id FROM video_sources
         WHERE lower(trim(source)) = lower(trim(?))
           AND upper(trim(external_code)) = upper(trim(?))
         ORDER BY video_id`
      ).all(source, externalCode) as Array<{ video_id: number }>).map((row) => row.video_id)
    } catch (error) {
      if (isMissingCatalogTable(error)) return []
      throw error
    }
  }

  private sqlVideoIdsBySourceUrl(source: string, sourceUrl: string): number[] {
    try {
      return (this.database.prepare(
        `SELECT video_id, url FROM video_sources
         WHERE lower(trim(source)) = lower(trim(?)) AND url IS NOT NULL
         ORDER BY video_id`
      ).all(source) as Array<{ video_id: number; url: string }>)
        .filter((row) => {
          try {
            return normalizePlaylistImportUrl(row.url) === sourceUrl
          } catch {
            return false
          }
        })
        .map((row) => row.video_id)
    } catch (error) {
      if (isMissingCatalogTable(error)) return []
      throw error
    }
  }

  private sqlVideoIdsByPublisherCodeRelease(
    normalizedPublisher: string,
    code: string,
    releaseDate: string
  ): number[] {
    try {
      return (this.database.prepare(
        `SELECT video.id AS video_id
         FROM videos video
         JOIN organization_name_ownership owner
           ON owner.organization_id = video.publisher_organization_id
         WHERE owner.normalized_name = ?
           AND upper(trim(video.code)) = ?
           AND video.release_date = ?
         ORDER BY video.id`
      ).all(normalizedPublisher, code, releaseDate) as Array<{ video_id: number }>).map(
        (row) => row.video_id
      )
    } catch (error) {
      if (isMissingCatalogTable(error)) return []
      throw error
    }
  }

  private candidatesFromCatalogRecords(
    records: PlaylistImportCatalogVideoRecord[]
  ): GlobalIdentityCandidate[] {
    return records
      .map((record) => ({
        videoId: record.videoId,
        code: record.code,
        libraryIds: record.libraryIds,
        publisherOrganizationId: record.publisherOrganizationId,
        releaseDate: record.releaseDate,
        identityRevision: catalogIdentityRevision(record)
      }))
      .sort((left, right) => left.videoId - right.videoId)
  }

  private globalCodeCandidates(code: string): GlobalIdentityCandidate[] {
    if (this.catalogLookup) {
      return this.candidatesFromCatalogRecords(this.catalogLookup.videosByCode(code))
    }
    try {
      const videos = this.database.prepare(
        `SELECT id, code, publisher_organization_id, release_date
         FROM videos WHERE upper(trim(code)) = ? ORDER BY id`
      ).all(code) as GlobalIdentityVideoRow[]
      return this.hydrateGlobalIdentityCandidates(videos)
    } catch (error) {
      if (isMissingCatalogTable(error)) return []
      throw error
    }
  }

  private globalDetailUrlCandidates(normalizedDetailUrl: string): GlobalIdentityCandidate[] {
    if (this.catalogLookup) {
      return this.candidatesFromCatalogRecords(
        this.catalogLookup.videosByDetailUrl(normalizedDetailUrl)
      )
    }
    try {
      const videos = this.database.prepare(
        `SELECT video.id, video.code, video.publisher_organization_id, video.release_date
         FROM video_links link
         JOIN videos video ON video.id = link.video_id
         WHERE link.normalized_url = ?
         ORDER BY video.id`
      ).all(normalizedDetailUrl) as GlobalIdentityVideoRow[]
      return this.hydrateGlobalIdentityCandidates(videos)
    } catch (error) {
      if (isMissingCatalogTable(error)) return []
      throw error
    }
  }

  private globalVideoCandidatesByIds(videoIds: number[]): GlobalIdentityCandidate[] {
    const ids = [...new Set(videoIds)].sort((left, right) => left - right)
    if (ids.length === 0) return []
    if (this.catalogLookup) {
      return this.candidatesFromCatalogRecords(this.catalogLookup.videosByIds(ids))
    }
    try {
      const placeholders = ids.map(() => '?').join(', ')
      const videos = this.database.prepare(
        `SELECT id, code, publisher_organization_id, release_date
         FROM videos WHERE id IN (${placeholders}) ORDER BY id`
      ).all(...ids) as GlobalIdentityVideoRow[]
      return this.hydrateGlobalIdentityCandidates(videos)
    } catch (error) {
      if (isMissingCatalogTable(error)) return []
      throw error
    }
  }

  private globalSourceIdentityCandidates(identity: {
    source?: string
    externalCode?: string
    sourceUrl?: string
  }): GlobalIdentityCandidate[] {
    if (this.catalogLookup) {
      return this.candidatesFromCatalogRecords(this.catalogLookup.videosBySourceIdentity(identity))
    }
    const source = identity.source?.trim()
    if (!source) return []
    try {
      const videoIds: number[] = []
      if (identity.externalCode?.trim()) {
        const rows = this.database.prepare(
          `SELECT video_id FROM video_sources
           WHERE lower(trim(source)) = lower(trim(?))
             AND upper(trim(external_code)) = upper(trim(?))
           ORDER BY video_id`
        ).all(source, identity.externalCode.trim()) as Array<{ video_id: number }>
        videoIds.push(...rows.map((row) => row.video_id))
      }
      if (identity.sourceUrl?.trim()) {
        let normalizedSourceUrl: string | null = null
        try {
          normalizedSourceUrl = normalizePlaylistImportUrl(identity.sourceUrl)
        } catch {
          normalizedSourceUrl = null
        }
        if (normalizedSourceUrl) {
          const rows = this.database.prepare(
            `SELECT video_id, url FROM video_sources
             WHERE lower(trim(source)) = lower(trim(?)) AND url IS NOT NULL
             ORDER BY video_id`
          ).all(source) as Array<{ video_id: number; url: string }>
          for (const row of rows) {
            try {
              if (normalizePlaylistImportUrl(row.url) === normalizedSourceUrl) {
                videoIds.push(row.video_id)
              }
            } catch {
              // Ignore malformed legacy source URLs; they cannot establish identity.
            }
          }
        }
      }
      return this.globalVideoCandidatesByIds(videoIds)
    } catch (error) {
      if (isMissingCatalogTable(error)) return []
      throw error
    }
  }

  private hydrateGlobalIdentityCandidates(
    videos: GlobalIdentityVideoRow[]
  ): GlobalIdentityCandidate[] {
    const memberships = this.database.prepare(
      `SELECT library_id FROM library_video_memberships WHERE video_id = ? ORDER BY library_id`
    )
    const links = this.database.prepare(
      'SELECT normalized_url FROM video_links WHERE video_id = ? ORDER BY normalized_url'
    )
    const sources = this.database.prepare(
      `SELECT source, external_code, url FROM video_sources
       WHERE video_id = ? ORDER BY source, external_code, url`
    )
    return videos.map((video) => {
      const libraryIds = (memberships.all(video.id) as Array<{ library_id: number }>)
        .map((row) => row.library_id)
      const relatedUrls = (links.all(video.id) as Array<{ normalized_url: string }>)
        .map((row) => row.normalized_url)
      const sourceRows = sources.all(video.id) as Array<{
        source: string
        external_code: string | null
        url: string | null
      }>
      return {
        videoId: video.id,
        code: video.code,
        libraryIds,
        publisherOrganizationId: video.publisher_organization_id,
        releaseDate: video.release_date,
        identityRevision: hash({
          code: normalizeVideoCode(video.code),
          publisherOrganizationId: video.publisher_organization_id,
          releaseDate: video.release_date,
          libraryIds,
          relatedUrls,
          sources: sourceRows
        })
      }
    })
  }

  private globalCodeCandidatesForCodes(
    codes: Array<string | null>
  ): GlobalIdentityCandidate[] {
    const candidates: GlobalIdentityCandidate[] = []
    for (const code of new Set(codes.filter((value): value is string => Boolean(value)))) {
      candidates.push(...this.globalCodeCandidates(code))
    }
    return this.mergeGlobalIdentityCandidates(candidates)
  }

  private mergeGlobalIdentityCandidates(
    ...groups: GlobalIdentityCandidate[][]
  ): GlobalIdentityCandidate[] {
    const byVideoId = new Map<number, GlobalIdentityCandidate>()
    for (const candidate of groups.flat()) byVideoId.set(candidate.videoId, candidate)
    return [...byVideoId.values()].sort((left, right) => left.videoId - right.videoId)
  }

  private canonicalDetailIdentity(input: {
    code: string | null
    detailUrl: string
    identity: Record<string, unknown>
    candidates: GlobalIdentityCandidate[]
  }): CanonicalDetailIdentity {
    const text = (key: string): string | undefined => {
      const value = input.identity[key]
      return typeof value === 'string' && value.trim() ? value.trim() : undefined
    }
    const canonical: CanonicalDetailIdentity = {
      detailUrl: normalizePlaylistImportUrl(input.detailUrl),
      ...(text('publisher') ? { publisher: text('publisher') } : {}),
      ...(text('releaseDate') ? { releaseDate: text('releaseDate') } : {}),
      ...(text('source') ? { source: text('source') } : {}),
      ...(text('externalCode') ? { externalCode: text('externalCode') } : {}),
      ...(text('sourceUrl') ? { sourceUrl: normalizePlaylistImportUrl(text('sourceUrl')!) } : {}),
      strongSignalConflict: false,
      strongSignalMismatch: false
    }
    const candidateIds = new Set(input.candidates.map((candidate) => candidate.videoId))
    const signals: number[][] = []
    const detailMatches = (
      this.catalogLookup
        ? this.catalogLookup.videosByDetailUrl(canonical.detailUrl).map((video) => video.videoId)
        : this.sqlVideoIdsByDetailUrl(canonical.detailUrl)
    ).filter((videoId) => candidateIds.has(videoId))
    if (detailMatches.length > 0) {
      signals.push(detailMatches)
      if (input.code && detailMatches.some((videoId) => {
        const candidate = input.candidates.find((entry) => entry.videoId === videoId)
        return candidate != null && normalizeVideoCode(candidate.code) !== input.code
      })) {
        canonical.strongSignalConflict = true
      }
    }

    if (canonical.source && canonical.externalCode) {
      const externalCodeMatches = (
        this.catalogLookup
          ? this.catalogLookup.videosBySourceIdentity({
              source: canonical.source,
              externalCode: canonical.externalCode
            }).map((video) => video.videoId)
          : this.sqlVideoIdsBySourceCode(canonical.source, canonical.externalCode)
      ).filter((videoId) => candidateIds.has(videoId))
      if (externalCodeMatches.length > 0) {
        signals.push(externalCodeMatches)
        if (input.code && externalCodeMatches.some((videoId) => {
          const candidate = input.candidates.find((entry) => entry.videoId === videoId)
          return candidate != null && normalizeVideoCode(candidate.code) !== input.code
        })) {
          canonical.strongSignalConflict = true
        }
      }
    }

    if (canonical.source && canonical.sourceUrl) {
      const sourceUrlMatches = (
        this.catalogLookup
          ? this.catalogLookup.videosBySourceIdentity({
              source: canonical.source,
              sourceUrl: canonical.sourceUrl
            }).map((video) => video.videoId)
          : this.sqlVideoIdsBySourceUrl(canonical.source, canonical.sourceUrl)
      ).filter((videoId) => candidateIds.has(videoId))
      if (sourceUrlMatches.length > 0) {
        signals.push(sourceUrlMatches)
        if (input.code && sourceUrlMatches.some((videoId) => {
          const candidate = input.candidates.find((entry) => entry.videoId === videoId)
          return candidate != null && normalizeVideoCode(candidate.code) !== input.code
        })) {
          canonical.strongSignalConflict = true
        }
      }
    }

    if (input.code && canonical.publisher && canonical.releaseDate) {
      let normalizedPublisher: string | null = null
      try {
        normalizedPublisher = normalizeClassificationName(canonical.publisher)
      } catch {
        normalizedPublisher = null
      }
      if (normalizedPublisher) {
        const businessMatches = (
          this.catalogLookup
            ? this.catalogLookup.videosByPublisherCodeRelease(
                normalizedPublisher,
                input.code,
                canonical.releaseDate
              ).map((video) => video.videoId)
            : this.sqlVideoIdsByPublisherCodeRelease(
                normalizedPublisher,
                input.code,
                canonical.releaseDate
              )
        ).filter((videoId) => candidateIds.has(videoId))
        if (businessMatches.length > 0) {
          signals.push(businessMatches)
        } else if (input.candidates.some((candidate) => (
          candidate.publisherOrganizationId != null && candidate.releaseDate != null
        ))) {
          canonical.strongSignalMismatch = true
        }
      }
    }

    if (signals.length === 0) return canonical
    const intersection = signals.slice(1).reduce(
      (current, signal) => current.filter((videoId) => signal.includes(videoId)),
      [...new Set(signals[0])]
    )
    const distinctSignalIds = new Set(signals.flat())
    if (intersection.length === 1) canonical.strongMatchVideoId = intersection[0]
    canonical.strongSignalConflict ||= intersection.length === 0 && distinctSignalIds.size > 1
    return canonical
  }

  currentCandidatesForItem(item: IdentityPreviewItem): GlobalIdentityCandidate[] {
    const identity = item.detail_identity_json
      ? JSON.parse(item.detail_identity_json) as CanonicalDetailIdentity
      : null
    return this.mergeGlobalIdentityCandidates(
      this.globalCodeCandidatesForCodes([
        item.normalized_code,
        identity?.codeConflict ? identity.detailCode ?? null : null
      ]),
      this.globalDetailUrlCandidates(item.normalized_detail_url),
      identity ? this.globalSourceIdentityCandidates(identity) : []
    )
  }

  isResolutionCurrent(job: { target_library_id: number }, item: IdentityPreviewItem): boolean {
    const candidates = this.currentCandidatesForItem(item)
    const frozenCandidates = item.candidate_snapshot_json ?? '[]'
    if (JSON.stringify(candidates) !== frozenCandidates) return false
    if (item.state === 'planned-create') {
      if (item.resolution_kind === 'create-no-match') return candidates.length === 0
      if (item.resolution_kind === 'user-create') {
        const decision = this.database.prepare(
          `SELECT expected_item_revision, choice_kind FROM playlist_import_decisions
           WHERE item_id = ?`
        ).get(item.id) as {
          expected_item_revision: number
          choice_kind: string
        } | undefined
        return decision?.choice_kind === 'create' && item.revision === decision.expected_item_revision + 1
      }
      return false
    }
    if (item.state !== 'planned-reuse' || item.resolved_video_id == null) return false
    if (!candidates.some((candidate) => candidate.videoId === item.resolved_video_id)) return false
    if (item.resolution_kind === 'user-existing') {
      const decision = this.database.prepare(
        `SELECT expected_item_revision, choice_kind, chosen_video_id
         FROM playlist_import_decisions WHERE item_id = ?`
      ).get(item.id) as {
        expected_item_revision: number
        choice_kind: string
        chosen_video_id: number | null
      } | undefined
      return decision?.choice_kind === 'existing' &&
        decision.chosen_video_id === item.resolved_video_id &&
        item.revision === decision.expected_item_revision + 1
    }
    if (['direct-code', 'target-library-tiebreak', 'business-identity'].includes(item.resolution_kind ?? '')) {
      const frozenIdentity = item.detail_identity_json
        ? JSON.parse(item.detail_identity_json) as CanonicalDetailIdentity : null
      if (item.resolution_kind === 'business-identity' && !frozenIdentity) return false
      const currentIdentity = frozenIdentity ? this.canonicalDetailIdentity({
        code: item.normalized_code,
        detailUrl: item.normalized_detail_url,
        identity: frozenIdentity as unknown as Record<string, unknown>,
        candidates
      }) : null
      if (currentIdentity && frozenIdentity?.codeConflict) currentIdentity.codeConflict = true
      const reuse = automaticReuse(candidates, currentIdentity, job.target_library_id)
      return reuse?.resolutionKind === item.resolution_kind && reuse.videoId === item.resolved_video_id
    }
    return false
  }

}
