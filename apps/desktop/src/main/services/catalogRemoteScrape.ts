import { randomUUID } from 'node:crypto'
import type { CatalogBackend, MutationContext } from '../application/catalogBackend'
import { ipcMutation } from '../application/mutationContext'
import type { ActressDetail } from '@shared/actressTypes'
import type { ActressScrapeDisposition, ActressScrapeField } from '@shared/actressScrapeTypes'
import { ALL_ACTRESS_SCRAPE_FIELDS } from '@shared/actressScrapeTypes'
import type { VideoDetail } from '@shared/videoTypes'
import type { CatalogImageRef, UploadPurpose } from '@shared/protocol/uploads'
import { isStructuredError } from '@shared/protocol/errors'
import { inspectServedImage, mediaAssetStore } from '@library/mediaAssetStore'
import { getDefaultNfoFileStore } from '../metadata-sources'
import type { MetadataAssetRef, VideoMetadataCandidate } from '../metadata-sources'
import { scrapeBrowser } from '../scrapers/scrapeBrowser'
import { isScrapeBrowserBusyError } from '../scrapers/scrapeBrowser'
import {
  collectVideoScrape,
  type ScrapeOutcome,
  type ScrapeVideoOptions
} from '../scrapers/scraperManager'
import {
  collectActressScrape,
  type ScrapeActressOptions
} from '../scrapers/actressScraperManager'
import { ALL_VIDEO_SCRAPE_FIELDS, type VideoScrapeField } from '@shared/videoScrapeTypes'
import { resolveVideoScrapeFieldSources } from '../scrapers/scraperManager'

function videoVersions(video: { generation?: number; revision?: number }, generation: number) {
  return {
    generation: video.generation ?? generation,
    revision: video.revision ?? 1
  }
}

function actressVersions(actress: { revision?: number }, generation: number) {
  return { generation, revision: actress.revision ?? 1 }
}

export async function resolveRemoteScrapeFields<T extends VideoScrapeField | ActressScrapeField>(
  backend: CatalogBackend,
  input: { kind: 'video' | 'actress'; id: number; fields: T[]; sourceName?: string; ratingSourceName?: string }
): Promise<T[]> {
  if (input.fields.length === 0) return []
  const result = await backend.queries.resolveScrapeFields(input)
  if (!result || !Array.isArray(result.fields) ||
      result.fields.some((field: unknown) => !input.fields.includes(field as T))) {
    throw new Error('远程刮削字段响应无效')
  }
  return input.fields.filter((field) => result.fields.includes(field))
}

async function readAsset(asset: MetadataAssetRef): Promise<Buffer> {
  if (asset.kind === 'remote-url') return scrapeBrowser.fetchBuffer(asset.url)
  return getDefaultNfoFileStore().readBytes(asset.capability, 64 * 1024 * 1024)
}

async function readUsableAsset(asset: MetadataAssetRef): Promise<Buffer | null> {
  try {
    const data = await readAsset(asset)
    return mediaAssetStore.isUsableImageBuffer(data) ? data : null
  } catch {
    return null
  }
}

async function uploadImage(
  backend: CatalogBackend,
  purpose: UploadPurpose,
  body: Buffer,
  ctx: MutationContext
): Promise<CatalogImageRef> {
  const contentType = await inspectServedImage(body)
  const created = (await backend.assets.createUpload({ purpose, contentType }, ctx)) as { uploadId: string }
  await backend.assets.putUpload({ uploadId: created.uploadId, body, contentType })
  return { kind: 'upload', uploadId: created.uploadId }
}

async function pendingForVideo(
  backend: CatalogBackend,
  videoId: number
): Promise<{ id: number; revision: number } | null> {
  const page = (await backend.pendingVideoScrapes.page({ videoId, limit: 1, offset: 0 })) as {
    items?: Array<{ id: number; revision: number; videoId: number }>
  }
  const item = page.items?.find((entry) => entry.videoId === videoId) ?? page.items?.[0]
  return item ? { id: item.id, revision: item.revision } : null
}

function mutationFor(
  backend: CatalogBackend,
  versions: MutationContext['expectedVersions']
): MutationContext {
  return ipcMutation(randomUUID(), versions)
}

function isConflictApplyError(error: unknown, token: string): boolean {
  return isStructuredError(error) && error.message.includes(token)
}

async function candidateImages(
  candidate: VideoMetadataCandidate,
  selectedFields: ReadonlySet<VideoScrapeField>
): Promise<{
  cover?: Buffer
  samples: Buffer[]
  actressAvatars: Array<{ name: string; data: Buffer }>
}> {
  const coverAsset = selectedFields.has('cover')
    ? candidate.assets.find((asset) => asset.field === 'cover')
    : undefined
  const cover = coverAsset ? (await readUsableAsset(coverAsset)) ?? undefined : undefined
  const sampleAssets = selectedFields.has('samples')
    ? candidate.assets
        .filter((asset) => asset.field === 'samples')
        .sort((left, right) => left.position - right.position)
    : []
  const sampleBuffers = await Promise.all(sampleAssets.map(readUsableAsset))
  const samples = sampleBuffers.every((data): data is Buffer => data !== null) ? sampleBuffers : []
  const actressAvatars: Array<{ name: string; data: Buffer }> = []
  const wantsFemale = selectedFields.has('actressesFemale')
  const wantsMale = selectedFields.has('actressesMale')
  if (wantsFemale || wantsMale) {
    for (const asset of candidate.assets.filter((item) => item.field === 'actressAvatar')) {
      const actress = candidate.result.actresses?.[asset.position]
      if (!actress) continue
      const gender = actress.gender ?? 'female'
      if ((gender === 'female' && !wantsFemale) || (gender === 'male' && !wantsMale)) continue
      const data = await readUsableAsset(asset)
      if (data) actressAvatars.push({ name: actress.name, data })
    }
  }
  return { cover, samples, actressAvatars }
}

export async function scrapeVideoThroughCatalog(
  backend: CatalogBackend,
  videoId: number,
  scraperName?: string,
  options?: ScrapeVideoOptions
): Promise<ScrapeOutcome> {
  const video = (await backend.queries.getVideo({
    scope: { kind: 'all' },
    videoId
  })) as VideoDetail | null
  if (!video) return { ok: false, error: '视频不存在' }
  const mode = options?.mode ?? 'replace'
  const requested = options?.fields ?? ALL_VIDEO_SCRAPE_FIELDS
  const fieldSources = resolveVideoScrapeFieldSources(scraperName)
  const effective = mode === 'fillEmpty'
    ? await resolveRemoteScrapeFields(backend, {
        kind: 'video', id: videoId, fields: requested, ...fieldSources
      })
    : requested
  if (effective.length === 0) {
    return { ok: true, result: { code: video.code }, skipped: true, warnings: [] }
  }

  try {
    const collectedRun = await collectVideoScrape({
      videoId,
      code: video.code,
      scraperName,
      fields: effective,
      delayController: options?.delayController
    })
    const { collected, compositeOutcome, source, descriptor, resolvedScraperName, requested: collectedFields } =
      collectedRun
    const candidate = collected.candidates[0]
    const result = candidate?.result
    if (!result) {
      if (source?.descriptor.kind === 'local-nfo' || compositeOutcome?.quietNoMatch) {
        return { ok: true, skipped: true, warnings: collected.warnings }
      }
      await backend.videos.markScrapeFailed(
        { videoId },
        mutationFor(backend, { V: videoVersions(video, backend.generation) })
      )
      return { ok: false, error: '未找到匹配的元数据', warnings: collected.warnings }
    }

    const hasAmbiguousSource = source
      ? collected.candidates.length > 1
      : compositeOutcome?.sources.some((item) => item.candidates.length > 1) ?? false
    const fieldsToApply = compositeOutcome?.matchedFields ?? collectedFields
    const pending = await pendingForVideo(backend, videoId)
    const versions = {
      V: videoVersions(video, backend.generation),
      ...(pending ? { Q: { generation: 1, revision: pending.revision } } : {})
    }

    if (hasAmbiguousSource) {
      const sources = source
        ? [
            {
              pluginName: resolvedScraperName,
              pluginSource: descriptor?.source ?? ('builtin' as const),
              pluginVersion: descriptor?.version ?? null,
              sourceName: collectedRun.sourceName,
              selectedFields: effective,
              candidates: collected.candidates
            }
          ]
        : (compositeOutcome?.sources ?? []).map((item) => ({
            pluginName: item.pluginName,
            pluginSource: item.descriptor?.source ?? ('builtin' as const),
            pluginVersion: item.descriptor?.version ?? null,
            sourceName: item.pluginName,
            selectedFields: item.selectedFields,
            candidates: item.candidates
          }))
      const mappedSources = []
      for (const item of sources) {
        const candidates = []
        for (const next of item.candidates) {
          const images = await candidateImages(next, new Set(item.selectedFields))
          const ctx = mutationFor(backend, {})
          candidates.push({
            result: next.result,
            sourceUrl: next.result.sourceUrl ?? null,
            ...(images.cover
              ? { cover: await uploadImage(backend, 'pendingScrapeStaging', images.cover, ctx) }
              : {}),
            ...(images.samples.length
              ? {
                  samples: await Promise.all(
                    images.samples.map((body) =>
                      uploadImage(backend, 'pendingScrapeStaging', body, mutationFor(backend, {}))
                    )
                  )
                }
              : {}),
            ...(images.actressAvatars.length
              ? {
                  actressAvatars: await Promise.all(
                    images.actressAvatars.map(async (avatar) => ({
                      name: avatar.name,
                      image: await uploadImage(
                        backend,
                        'pendingScrapeStaging',
                        avatar.data,
                        mutationFor(backend, {})
                      )
                    }))
                  )
                }
              : {})
          })
        }
        mappedSources.push({
          pluginName: item.pluginName,
          pluginSource: item.pluginSource,
          pluginVersion: item.pluginVersion,
          pluginConfig: { supportedFields: item.selectedFields },
          sourceName: item.sourceName,
          selectedFields: item.selectedFields,
          candidates
        })
      }
      const replaced = (await backend.pendingVideoScrapes.replace(
        {
          videoId,
          selectedFields: requested,
          applicableFields: fieldsToApply,
          updateMode: mode,
          request: {
            scraperName: resolvedScraperName,
            fields: requested,
            mode
          },
          warnings: collected.warnings,
          sources: mappedSources
        },
        mutationFor(backend, versions)
      )) as { pendingScrapeId?: number }
      return {
        ok: true,
        pending: true,
        pendingScrapeId: replaced.pendingScrapeId,
        skipped: true,
        warnings: collected.warnings,
        classifications: []
      }
    }

    const images = await candidateImages(candidate, new Set(effective))
    const applyCtx = mutationFor(backend, versions)
    const cover = images.cover
      ? await uploadImage(backend, 'videoCover', images.cover, mutationFor(backend, {}))
      : undefined
    const samples = images.samples.length
      ? await Promise.all(
          images.samples.map((body) => uploadImage(backend, 'videoSample', body, mutationFor(backend, {})))
        )
      : undefined
    const actressAvatars = images.actressAvatars.length
      ? await Promise.all(
          images.actressAvatars.map(async (avatar) => ({
            name: avatar.name,
            image: await uploadImage(backend, 'actressAvatar', avatar.data, mutationFor(backend, {}))
          }))
        )
      : undefined
    try {
      const applied = (await backend.videos.applyScrapeCandidate(
        {
          videoId,
          fields: fieldsToApply,
          mode,
          candidate: result,
          cover,
          samples,
          actressAvatars,
          directorSelectionId: options?.directorSelectionId,
          directorAmbiguity: options?.directorAmbiguity ?? 'preserve'
        },
        applyCtx
      )) as {
        applied?: boolean
        warnings?: string[]
        directorChoice?: ScrapeOutcome['directorChoice']
      }
      if (applied.directorChoice) {
        return {
          ok: true,
          result,
          skipped: true,
          warnings: [...collected.warnings, ...(applied.warnings ?? [])],
          classifications: [],
          directorChoice: applied.directorChoice
        }
      }
      return {
        ok: true,
        result,
        skipped: applied.applied === false,
        warnings: [...collected.warnings, ...(applied.warnings ?? [])],
        classifications: []
      }
    } catch (error) {
      if (!isConflictApplyError(error, '业务身份冲突')) throw error
      const imagesForPending = await candidateImages(candidate, new Set(fieldsToApply))
      const ctx = mutationFor(backend, {})
      const replaced = (await backend.pendingVideoScrapes.replace(
        {
          videoId,
          selectedFields: requested,
          applicableFields: fieldsToApply,
          updateMode: mode,
          request: { scraperName: resolvedScraperName, fields: requested, mode },
          warnings: [
            ...collected.warnings,
            error instanceof Error ? error.message : String(error)
          ],
          sources: [
            {
              pluginName: resolvedScraperName,
              pluginSource: descriptor?.source ?? 'builtin',
              pluginVersion: descriptor?.version ?? null,
              sourceName: collectedRun.sourceName,
              selectedFields: effective,
              candidates: [
                {
                  result,
                  sourceUrl: result.sourceUrl ?? null,
                  ...(imagesForPending.cover
                    ? {
                        cover: await uploadImage(
                          backend,
                          'pendingScrapeStaging',
                          imagesForPending.cover,
                          ctx
                        )
                      }
                    : {}),
                  ...(imagesForPending.samples.length
                    ? {
                        samples: await Promise.all(
                          imagesForPending.samples.map((body) =>
                            uploadImage(backend, 'pendingScrapeStaging', body, mutationFor(backend, {}))
                          )
                        )
                      }
                    : {}),
                  ...(imagesForPending.actressAvatars.length
                    ? {
                        actressAvatars: await Promise.all(
                          imagesForPending.actressAvatars.map(async (avatar) => ({
                            name: avatar.name,
                            image: await uploadImage(
                              backend,
                              'pendingScrapeStaging',
                              avatar.data,
                              mutationFor(backend, {})
                            )
                          }))
                        )
                      }
                    : {})
                }
              ]
            }
          ]
        },
        mutationFor(backend, versions)
      )) as { pendingScrapeId?: number }
      return {
        ok: true,
        pending: true,
        pendingScrapeId: replaced.pendingScrapeId,
        skipped: true,
        warnings: collected.warnings,
        classifications: []
      }
    }
  } catch (err) {
    if (!isScrapeBrowserBusyError(err) && !(isStructuredError(err) && err.code === 'VERSION_CONFLICT')) {
      try {
        await backend.videos.markScrapeFailed(
          { videoId },
          mutationFor(backend, { V: videoVersions(video, backend.generation) })
        )
      } catch {
        // The original scrape error is more useful than a follow-up mark-failed failure.
      }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (options?.closeBrowser !== false) scrapeBrowser.close()
  }
}

export async function scrapeActressThroughCatalog(
  backend: CatalogBackend,
  actressId: number,
  scraperName?: string,
  options?: ScrapeActressOptions
): Promise<ActressScrapeDisposition> {
  const detail = (await backend.actresses.get({ actressId })) as ActressDetail | null
  if (!detail) return { status: 'failure', ok: false, error: '演员不存在' }
  const requested = options?.fields ?? ALL_ACTRESS_SCRAPE_FIELDS
  const mode = options?.mode ?? 'replace'
  const effective = mode === 'fillEmpty'
    ? await resolveRemoteScrapeFields(backend, { kind: 'actress', id: actressId, fields: requested })
    : requested
  if (effective.length === 0) {
    return { status: 'success', ok: true, result: {}, skipped: true }
  }
  try {
    const collected = await collectActressScrape({
      mainName: detail.main_name,
      aliases: detail.aliases,
      nameZh: detail.name_zh,
      nameEn: detail.name_en,
      scraperName,
      fields: effective,
      requested,
      queryName: options?.queryName,
      useAliases: options?.useAliases,
      delayController: options?.delayController
    })
    if (!collected.result) {
      await backend.actresses.markScrapeFailed(
        { actressId },
        mutationFor(backend, { A: actressVersions(detail, backend.generation) })
      )
      return {
        status: 'failure',
        ok: false,
        error: '未找到匹配的演员资料',
        warnings: collected.sourceWarnings.length > 0 ? collected.sourceWarnings : undefined
      }
    }
    const versions = {
      A: actressVersions(detail, backend.generation)
    }
    const avatarResource = collected.resources.find((resource) => resource.field === 'avatar')
    const galleryResources = collected.resources
      .filter((resource) => resource.field === 'gallery')
      .sort((left, right) => left.position - right.position)
    const avatar = avatarResource
      ? await uploadImage(backend, 'actressAvatar', avatarResource.data, mutationFor(backend, {}))
      : undefined
    const gallery = galleryResources.length
      ? await Promise.all(
          galleryResources.map((resource) =>
            uploadImage(backend, 'actressGallery', resource.data, mutationFor(backend, {}))
          )
        )
      : undefined
    try {
      const applied = (await backend.actresses.applyScrapeCandidate(
        {
          actressId,
          candidate: collected.result,
          avatar,
          gallery,
          fields: collected.fieldsToApply.filter((field) => effective.includes(field)),
          mode
        },
        mutationFor(backend, versions)
      )) as { applied?: boolean; warnings?: string[] }
      if (applied.applied === false) {
        return {
          status: 'success',
          ok: true,
          result: collected.result,
          skipped: true,
          warnings: [...collected.sourceWarnings, ...(applied.warnings ?? [])]
        }
      }
      return {
        status: 'success',
        ok: true,
        result: collected.result,
        warnings: [...collected.sourceWarnings, ...(applied.warnings ?? [])].length
          ? [...collected.sourceWarnings, ...(applied.warnings ?? [])]
          : undefined,
        avatarUpdated: Boolean(avatar)
      }
    } catch (error) {
      if (!isConflictApplyError(error, '名称归属冲突')) throw error
      const pendingAvatar = avatarResource
        ? await uploadImage(backend, 'pendingScrapeStaging', avatarResource.data, mutationFor(backend, {}))
        : undefined
      const pendingGallery = galleryResources.length
        ? await Promise.all(
            galleryResources.map((resource) =>
              uploadImage(backend, 'pendingScrapeStaging', resource.data, mutationFor(backend, {}))
            )
          )
        : undefined
      const submitted = (await backend.actresses.submitConflict(
        {
          actressId,
          pluginName: collected.selectedScraperName,
          pluginSource: collected.descriptor?.source ?? 'builtin',
          pluginVersion: collected.descriptor?.version ?? null,
          queryName: collected.queryName,
          selectedFields: requested,
          applicableFields: collected.fieldsToApply.filter((field) => effective.includes(field)),
          mode,
          candidate: collected.result,
          warnings: collected.sourceWarnings,
          batchJobId: options?.batchJobId ?? null,
          avatar: pendingAvatar,
          gallery: pendingGallery
        },
        mutationFor(backend, versions)
      )) as { pendingId?: number }
      return {
        status: 'pending',
        ok: true,
        pendingId: submitted.pendingId ?? 0,
        result: collected.result,
        warnings: collected.sourceWarnings.length > 0 ? collected.sourceWarnings : undefined
      }
    }
  } catch (err) {
    if (!isScrapeBrowserBusyError(err) && !(isStructuredError(err) && err.code === 'VERSION_CONFLICT')) {
      try {
        await backend.actresses.markScrapeFailed(
          { actressId },
          mutationFor(backend, { A: actressVersions(detail, backend.generation) })
        )
      } catch {
        // Prefer the original scrape error.
      }
    }
    return { status: 'failure', ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (options?.closeBrowser !== false) scrapeBrowser.close()
  }
}
