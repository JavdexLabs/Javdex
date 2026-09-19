import { randomUUID } from 'node:crypto'
import { runVideoCandidateWorkflow, runActressCandidateWorkflow } from './scrapeCandidateWorkflow'
import type { CatalogBackend, MutationContext } from '../application/catalogBackend'
import { ipcMutation } from '../application/mutationContext'
import type { ActressDetail } from '@shared/actressTypes'
import type { ActressScrapeDisposition, ActressScrapeField } from '@shared/actressScrapeTypes'
import { ALL_ACTRESS_SCRAPE_FIELDS } from '@shared/actressScrapeTypes'
import type { VideoDetail } from '@shared/videoTypes'
import type { CatalogImageRef, UploadPurpose } from '@shared/protocol/uploads'
import type { OperationReceipt } from '@shared/protocol/operationReceipt'
import { isStructuredError, structuredError, toStructuredError } from '@shared/protocol/errors'
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

function videoVersions(
  video: { generation?: number; revision?: number },
  expected?: { generation?: number; revision: number }
) {
  return {
    generation: expected?.generation ?? video.generation ?? 1,
    revision: expected?.revision ?? video.revision ?? 1
  }
}

function actressVersions(
  actress: { generation?: number; revision?: number },
  expected?: { generation?: number; revision: number }
) {
  return {
    generation: expected?.generation ?? actress.generation ?? 1,
    revision: expected?.revision ?? actress.revision ?? 1
  }
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

async function readAsset(asset: MetadataAssetRef, sourceUrl?: string): Promise<Buffer> {
  if (asset.kind === 'remote-url') return scrapeBrowser.fetchBuffer(asset.url, { referer: sourceUrl || 'omit' })
  return getDefaultNfoFileStore().readBytes(asset.capability, 64 * 1024 * 1024)
}

async function readUsableAsset(asset: MetadataAssetRef, sourceUrl?: string): Promise<Buffer | null> {
  try {
    const data = await readAsset(asset, sourceUrl)
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
  // inspectServedImage validates the same closed set of served image MIME types.
  const contentType = await inspectServedImage(body) as
    Parameters<CatalogBackend['assets']['createUpload']>[0]['contentType']
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

async function readRemoteMutationReceipt(
  backend: CatalogBackend,
  operationId: string
): Promise<OperationReceipt | null> {
  try {
    const value = await backend.tasks.getOperation({ operationId })
    if (!value || typeof value !== 'object') return null
    return value as OperationReceipt
  } catch {
    return null
  }
}

function isAcceptedRemoteMutation(receipt: OperationReceipt | null): boolean {
  return receipt?.status === 'applied' || receipt?.status === 'duplicate' || receipt?.status === 'acceptedTask'
}

function unknownRemoteMutationError(operationId: string) {
  return structuredError(
    'CONNECTION_UNAVAILABLE',
    '远程提交结果未知，请查询操作状态后再继续',
    { operationId },
    operationId
  )
}

function isConflictApplyError(error: unknown): boolean {
  return isStructuredError(error) && error.code === 'IDENTITY_CONFLICT'
}

async function candidateImages(
  candidate: VideoMetadataCandidate,
  selectedFields?: ReadonlySet<VideoScrapeField>
): Promise<{
  cover?: Buffer
  samples: Buffer[]
  actressAvatars: Array<{ name: string; data: Buffer }>
}> {
  const coverAsset = (!selectedFields || selectedFields.has('cover'))
    ? candidate.assets.find((asset) => asset.field === 'cover')
    : undefined
  const cover = coverAsset ? (await readUsableAsset(coverAsset, candidate.result.sourceUrl)) ?? undefined : undefined
  const sampleAssets = (!selectedFields || selectedFields.has('samples'))
    ? candidate.assets
      .filter((asset) => asset.field === 'samples')
      .sort((left, right) => left.position - right.position)
    : []
  const sampleBuffers = await Promise.all(sampleAssets.map((asset) => readUsableAsset(asset, candidate.result.sourceUrl)))
  const samples = sampleBuffers.every((data): data is Buffer => data !== null) ? sampleBuffers : []
  const actressAvatars: Array<{ name: string; data: Buffer }> = []
  const wantsFemale = !selectedFields || selectedFields.has('actressesFemale')
  const wantsMale = !selectedFields || selectedFields.has('actressesMale')
  if (wantsFemale || wantsMale) {
    for (const asset of candidate.assets.filter((item) => item.field === 'actressAvatar')) {
      const actress = candidate.result.actresses?.[asset.position]
      if (!actress) continue
      const gender = actress.gender ?? 'female'
      if ((gender === 'female' && !wantsFemale) || (gender === 'male' && !wantsMale)) continue
      const data = await readUsableAsset(asset, candidate.result.sourceUrl)
      if (data) actressAvatars.push({ name: actress.name, data })
    }
  }
  return { cover, samples, actressAvatars }
}

/** Both ambiguous results and identity conflicts retain the complete candidate. */
async function uploadPendingVideoCandidate(backend: CatalogBackend, candidate: VideoMetadataCandidate) {
  const images = await candidateImages(candidate)
  const ctx = mutationFor(backend, {})
  return {
    result: candidate.result,
    sourceUrl: candidate.result.sourceUrl ?? null,
    ...(images.cover
      ? { cover: await uploadImage(backend, 'pendingScrapeStaging', images.cover, ctx) }
      : {}),
    ...(images.samples.length
      ? {
          samples: await Promise.all(images.samples.map((body) =>
            uploadImage(backend, 'pendingScrapeStaging', body, mutationFor(backend, {}))
          ))
        }
      : {}),
    ...(images.actressAvatars.length
      ? {
          actressAvatars: await Promise.all(images.actressAvatars.map(async (avatar) => ({
            name: avatar.name,
            image: await uploadImage(backend, 'pendingScrapeStaging', avatar.data, mutationFor(backend, {}))
          })))
        }
      : {})
  }
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
    return await runVideoCandidateWorkflow({
      videoId,
      code: video.code,
      scraperName,
      fields: effective,
      delayController: options?.delayController,
      preLogin: options?.preLogin
    }, {
      collect: collectVideoScrape,
      markFailed: async () => {
        await backend.videos.markScrapeFailed(
          { videoId },
          mutationFor(backend, { V: videoVersions(video, options?.expectedVersion) })
        )
      },
      prepare: async () => {
        const pending = await pendingForVideo(backend, videoId)
        const versions = {
          V: videoVersions(video, options?.expectedVersion),
          ...(pending ? { Q: { generation: 1, revision: pending.revision } } : {})
        }

        return versions
      },
      reviewWarnings: () => null,
      pending: async ({ run: collectedRun, fieldsToApply, sources }, versions, warnings) => {
        const { resolvedScraperName } = collectedRun
        const mappedSources = []
        for (const item of sources) {
          const candidates = []
          for (const next of item.candidates) {
            candidates.push(await uploadPendingVideoCandidate(backend, next))
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
            warnings,
            sources: mappedSources
          },
          mutationFor(backend, versions)
        )) as { pendingScrapeId?: number }
        return {
          ok: true,
          pending: true,
          pendingScrapeId: replaced.pendingScrapeId,
          skipped: true,
          warnings,
          classifications: []
        }
      },
      apply: async ({ run: collectedRun, candidate, fieldsToApply }, versions) => {
        const { collected, descriptor, resolvedScraperName } = collectedRun
        const result = candidate.result
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
              sourceName: fieldSources.sourceName,
              ratingSourceName: fieldSources.ratingSourceName,
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
          if (isStructuredError(error) && error.code === 'CONNECTION_UNAVAILABLE') {
            const receipt = await readRemoteMutationReceipt(backend, applyCtx.operationId)
            if (isAcceptedRemoteMutation(receipt)) {
              return {
                ok: true,
                result,
                skipped: false,
                warnings: collected.warnings,
                classifications: []
              }
            }
            if (!receipt || receipt.status === 'unknown') {
              const unknown = unknownRemoteMutationError(applyCtx.operationId)
              return { ok: false, error: unknown.message, errorDetails: unknown }
            }
          }
          if (!isConflictApplyError(error)) throw error
          const pendingCandidate = await uploadPendingVideoCandidate(backend, candidate)
          const replaced = (await backend.pendingVideoScrapes.replace(
            {
              videoId,
              selectedFields: requested,
              applicableFields: fieldsToApply,
              updateMode: mode,
              request: { scraperName: resolvedScraperName, fields: requested, mode },
              warnings: [
                ...collected.warnings,
                toStructuredError(error).message
              ],
              sources: [
                {
                  pluginName: resolvedScraperName,
                  pluginSource: descriptor?.source ?? 'builtin',
                  pluginVersion: descriptor?.version ?? null,
                  sourceName: collectedRun.sourceName,
                  selectedFields: effective,
                  candidates: [pendingCandidate]
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
      }
    })
  } catch (err) {
    if (!isScrapeBrowserBusyError(err) && !(isStructuredError(err) && err.code === 'VERSION_CONFLICT')) {
      try {
        await backend.videos.markScrapeFailed(
          { videoId },
          mutationFor(backend, { V: videoVersions(video, options?.expectedVersion) })
        )
      } catch {
        // The original scrape error is more useful than a follow-up mark-failed failure.
      }
    }
    const errorDetails = toStructuredError(err)
    return { ok: false, error: errorDetails.message, errorDetails }
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
  return runActressCandidateWorkflow({
    mainName: detail.main_name,
    aliases: detail.aliases,
    nameZh: detail.name_zh,
    nameEn: detail.name_en,
    scraperName,
    fields: effective,
    requested,
    queryName: options?.queryName,
    useAliases: options?.useAliases,
    delayController: options?.delayController,
    preLogin: options?.preLogin
  }, {
    collect: collectActressScrape,
    markFailed: async () => {
      await backend.actresses.markScrapeFailed(
        { actressId },
        mutationFor(backend, { A: actressVersions(detail, options?.expectedVersion) })
      )
    },
    persist: async (collected) => {
      const versions = {
        A: actressVersions(detail, options?.expectedVersion)
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
      const applyCtx = mutationFor(backend, versions)
      try {
        const applied = (await backend.actresses.applyScrapeCandidate(
          {
            actressId,
            candidate: collected.result,
            avatar,
            gallery,
            fields: collected.applicableFields,
            mode
          },
          applyCtx
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
        if (isStructuredError(error) && error.code === 'CONNECTION_UNAVAILABLE') {
          const receipt = await readRemoteMutationReceipt(backend, applyCtx.operationId)
          if (isAcceptedRemoteMutation(receipt)) {
            return {
              status: 'success',
              ok: true,
              result: collected.result,
              warnings: collected.sourceWarnings.length > 0 ? collected.sourceWarnings : undefined
            }
          }
          if (!receipt || receipt.status === 'unknown') {
            const unknown = unknownRemoteMutationError(applyCtx.operationId)
            return { status: 'failure', ok: false, error: unknown.message, errorDetails: unknown }
          }
        }
        if (!isConflictApplyError(error)) throw error
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
            applicableFields: collected.applicableFields,
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
    },
    onError: async (err) => {
      if (!isScrapeBrowserBusyError(err) && !(isStructuredError(err) && err.code === 'VERSION_CONFLICT')) {
        try {
          await backend.actresses.markScrapeFailed(
            { actressId },
            mutationFor(backend, { A: actressVersions(detail, options?.expectedVersion) })
          )
        } catch {
          // Prefer the original scrape error.
        }
      }
      const errorDetails = toStructuredError(err)
      return { status: 'failure', ok: false, error: errorDetails.message, errorDetails }
    },
    close: () => {
      if (options?.closeBrowser !== false) scrapeBrowser.close()
    }
  })
}
