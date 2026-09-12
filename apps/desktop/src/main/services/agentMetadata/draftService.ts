import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  AgentMetadataApplyInput,
  AgentMetadataApplyOutcome,
  AgentMetadataDraft,
  AgentMetadataDraftPayload,
  AgentMetadataDraftResource,
  AgentMetadataPlanInput,
  AgentMetadataReview,
  AgentMetadataTarget
} from '@shared/agentMetadataTypes'
import {
  ALL_ACTRESS_SCRAPE_FIELDS,
  type ActressScrapeField,
  type ActressScrapeResult
} from '@shared/actressScrapeTypes'
import {
  ALL_VIDEO_SCRAPE_FIELDS,
  type ScrapeResult,
  type ScrapedActress,
  type VideoScrapeField
} from '@shared/videoScrapeTypes'
import { normalizeVideoCode } from '@shared/videoCode'
import { normalizeActressName } from '@shared/actressNameNormalization'
import { getActressDetail } from '@library/db/actressRepo'
import { agentMetadataDraftRepo, type AgentMetadataDraftRepo } from '@library/db/agentMetadataDraftRepo'
import { getDb } from '@library/db/database'
import { replacePendingVideoScrape } from '@library/db/pendingVideoScrapeRepo'
import { getVideoById } from '@library/db/videoRepo'
import {
  normalizeActressScrapeResult,
  normalizeVideoScrapeResult
} from '../../scrapers/scraperResultValidation'
import { mediaAssetStore } from '@library/mediaAssetStore'
import {
  applyActressScrapeResult,
  planActressScrapeResult,
  resolveEffectiveActressScrapeFields
} from '../actressAssetService'
import {
  actressIdentityConflictWorkflow,
  findActressScrapeNameConflicts
} from '../actressIdentityConflictWorkflow'
import {
  findVideoBusinessIdentityConflictForScrape,
  videoScrapeApplyService
} from '../videoScrapeApplyService'
import {
  agentMetadataBrowser,
  sanitizeAgentMetadataUrl,
  type AgentMetadataBrowserAdapter
} from './browserAdapter'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_IMAGE_BYTES = 200 * 1024 * 1024

class PreviewStaleError extends Error {}

function unsupportedTarget(target: never): never {
  throw new Error(`不支持的 Agent 元数据目标：${JSON.stringify(target)}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function uniqueAllowed<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string
): T[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组。`)
  const allowedSet = new Set<string>(allowed)
  const output: T[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !allowedSet.has(item)) throw new Error(`${label} 包含不支持的字段。`)
    if (!output.includes(item as T)) output.push(item as T)
  }
  return output
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function reviewToken(
  review: Omit<AgentMetadataReview, 'token'>,
  resources: AgentMetadataDraftResource[]
): string {
  return createHash('sha256')
    .update(canonical({ review, resources: resourceManifest(resources) }))
    .digest('base64url')
}

function resourceManifest(resources: AgentMetadataDraftResource[]): Array<Record<string, unknown>> {
  return resources.map((resource) => ({
    field: resource.field,
    position: resource.position,
    remoteUrl: resource.remoteUrl,
    stagedPath: resource.stagedPath,
    width: resource.width,
    height: resource.height,
    sizeBytes: resource.sizeBytes,
    sha256: resource.sha256
  }))
}

function excludeRetainedStagingDirectories(obsolete: string[], retained: string[]): string[] {
  const retainedDirectories = new Set(retained.map((stagedPath) => path.posix.dirname(stagedPath)))
  return obsolete.filter((stagedPath) => !retainedDirectories.has(path.posix.dirname(stagedPath)))
}

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex')
}

function valuesPresentForVideo(result: ScrapeResult, field: VideoScrapeField): boolean {
  switch (field) {
    case 'title': return Boolean(result.title)
    case 'summary': return Boolean(result.summary)
    case 'cover': return Boolean(result.coverUrl)
    case 'releaseDate': return Boolean(result.releaseDate)
    case 'maker': return Boolean(result.maker)
    case 'publisher': return Boolean(result.publisher)
    case 'series': return Boolean(result.series)
    case 'director': return Boolean(result.director)
    case 'duration': return result.durationSeconds != null
    case 'actressesFemale': return Boolean(result.actresses?.some((item) => (item.gender ?? 'female') === 'female'))
    case 'actressesMale': return Boolean(result.actresses?.some((item) => item.gender === 'male'))
    case 'tags': return Boolean(result.tags?.length)
    case 'source': return Boolean(result.sourceUrl)
    case 'rating': return result.ratingAverage != null
    case 'samples': return Boolean(result.sampleImageUrls?.length)
  }
}

function valuesPresentForActress(result: ActressScrapeResult, field: ActressScrapeField): boolean {
  switch (field) {
    case 'avatar': return Boolean(result.avatarUrl)
    case 'gallery': return Boolean(result.galleryImageUrls?.length)
    case 'birthDate': return Boolean(result.birthDate)
    case 'nameZh': return Boolean(result.nameZh)
    case 'nameEn': return Boolean(result.nameEn)
    case 'debutDate': return Boolean(result.debutDate)
    case 'heightCm': return result.heightCm != null
    case 'measurements': return result.bustCm != null || result.waistCm != null || result.hipCm != null
    case 'cupSize': return Boolean(result.cupSize)
    case 'bloodType': return Boolean(result.bloodType)
    case 'zodiac': return Boolean(result.zodiac)
    case 'nationality': return Boolean(result.nationality)
    case 'profileSummary': return Boolean(result.profileSummary)
    case 'aliases': return Boolean(result.aliases?.length)
  }
}

function validateObservedFields<T extends string>(input: {
  observed: T[]
  explicitlyEmpty: T[]
  hasValue: (field: T) => boolean
}): void {
  const observed = new Set(input.observed)
  for (const field of input.explicitlyEmpty) {
    if (!observed.has(field)) throw new Error(`明确为空的字段 ${field} 未列入 observedFields。`)
    if (input.hasValue(field)) throw new Error(`字段 ${field} 同时包含值并被声明为空。`)
  }
  const explicit = new Set(input.explicitlyEmpty)
  for (const field of input.observed) {
    if (!input.hasValue(field) && !explicit.has(field)) {
      throw new Error(`字段 ${field} 没有可用值，也没有被明确声明为空。`)
    }
  }
}

function sanitizePayloadResourceUrls(payload: AgentMetadataDraftPayload): void {
  if (payload.kind === 'video') {
    if (payload.result.coverUrl) payload.result.coverUrl = sanitizeAgentMetadataUrl(payload.result.coverUrl)
    if (payload.result.sampleImageUrls) {
      payload.result.sampleImageUrls = payload.result.sampleImageUrls.map(sanitizeAgentMetadataUrl)
    }
    for (const actress of payload.result.actresses ?? []) {
      if (actress.avatarUrl) actress.avatarUrl = sanitizeAgentMetadataUrl(actress.avatarUrl)
    }
    return
  }
  if (payload.result.avatarUrl) payload.result.avatarUrl = sanitizeAgentMetadataUrl(payload.result.avatarUrl)
  if (payload.result.galleryImageUrls) {
    payload.result.galleryImageUrls = payload.result.galleryImageUrls.map(sanitizeAgentMetadataUrl)
  }
}

export class AgentMetadataDraftService {
  private readonly verifiedResourceManifests = new Map<string, string>()

  constructor(
    private readonly repo: AgentMetadataDraftRepo = agentMetadataDraftRepo,
    private readonly browser: AgentMetadataBrowserAdapter = agentMetadataBrowser
  ) {}

  async prepare(input: {
    runId: string
    target: AgentMetadataTarget
    args: Record<string, unknown>
    signal: AbortSignal
  }): Promise<AgentMetadataDraftPayload> {
    if (Buffer.byteLength(JSON.stringify(input.args), 'utf8') > 1024 * 1024) {
      throw new Error('Agent 元数据候选超过 1 MiB 上限。')
    }
    const source = this.browser.source(input.runId)
    const payload = this.parsePayload(
      input.runId,
      input.target,
      input.args,
      source.finalUrl ?? source.requestedUrl
    )
    const warnings: string[] = []
    const resources = await this.stageResources(input.runId, payload, warnings, input.signal)
    try {
      sanitizePayloadResourceUrls(payload)
      input.signal.throwIfAborted()
      const created = this.repo.create({
        id: randomUUID(),
        runId: input.runId,
        target: input.target,
        source,
        payload,
        resources,
        warnings
      })
      this.verifiedResourceManifests.clear()
      this.cleanupStaging(input.target.kind, created.supersededStagedPaths)
      return payload
    } catch (error) {
      this.cleanupStaging(input.target.kind, resources.map((resource) => resource.stagedPath))
      throw error
    }
  }

  getDraft(draftId: string): AgentMetadataDraft | null {
    return this.repo.get(draftId)
  }

  findReadyForTarget(target: AgentMetadataTarget): AgentMetadataDraft | null {
    return this.repo.findReadyForTarget(target)
  }

  findByRunId(runId: string): AgentMetadataDraft | null {
    return this.repo.findByRunId(runId)
  }

  plan(selection: AgentMetadataPlanInput): AgentMetadataReview {
    const draft = this.repo.require(selection.draftId)
    if (draft.status !== 'ready') throw new Error('该元数据草稿已结束，不能重新预览。')
    if (draft.revision !== selection.expectedRevision) throw new Error('草稿已更新，请重新加载。')
    if (selection.kind !== draft.target.kind || selection.kind !== draft.payload.kind) {
      throw new Error('元数据草稿类型与预览请求不一致。')
    }
    const revision = draft.revision + 1
    const normalizedSelection = { ...selection, expectedRevision: revision } as AgentMetadataPlanInput
    const review = this.buildReview(draft, normalizedSelection, revision)
    return this.repo.saveReview({
      draftId: draft.id,
      expectedRevision: draft.revision,
      review
    })
  }

  apply(input: AgentMetadataApplyInput): AgentMetadataApplyOutcome {
    const replay = this.repo.getStoredOutcome({
      draftId: input.draftId,
      idempotencyKey: input.idempotencyKey
    })
    if (replay) return replay
    const draft = this.repo.require(input.draftId)
    const stored = this.repo.getStoredReview(input.draftId)
    if (draft.status !== 'ready' || !stored || stored.token !== input.reviewToken) {
      throw new Error('预览已过期，请重新检查后再应用。')
    }
    if (!stored.canApply) throw new Error('当前预览仍有必须处理的问题。')
    const current = this.buildReview(draft, stored.selection, stored.revision, true)
    if (current.token !== stored.token) return this.staleOutcome(draft, stored)

    try {
      const outcome = draft.target.kind === 'video'
        ? this.applyVideo(draft, stored, input)
        : draft.target.kind === 'actress'
          ? this.applyActress(draft, stored, input)
          : unsupportedTarget(draft.target)
      this.verifiedResourceManifests.delete(draft.id)
      return outcome
    } catch (error) {
      if (error instanceof PreviewStaleError) return this.staleOutcome(this.repo.require(draft.id), stored)
      throw error
    }
  }

  discard(input: { draftId: string; expectedRevision: number }): void {
    const draft = this.repo.require(input.draftId)
    const discarded = this.repo.discard(input)
    this.verifiedResourceManifests.delete(draft.id)
    this.cleanupStaging(draft.target.kind, discarded.stagedPaths)
  }

  private staleOutcome(
    draft: AgentMetadataDraft,
    stored: AgentMetadataReview
  ): AgentMetadataApplyOutcome {
    const review = this.plan({ ...stored.selection, expectedRevision: draft.revision } as AgentMetadataPlanInput)
    return {
      status: 'preview_stale',
      target: draft.target,
      review,
      warnings: ['媒体库内容在预览后发生变化，请检查更新后的影响后再应用。']
    }
  }

  private parsePayload(
    runId: string,
    target: AgentMetadataTarget,
    args: Record<string, unknown>,
    sourceUrl: string
  ): AgentMetadataDraftPayload {
    if (args.kind !== target.kind || !isRecord(args.data)) throw new Error('候选类型与当前目标不一致。')
    if (!Array.isArray(args.evidenceRefs) || args.evidenceRefs.length === 0) {
      throw new Error('候选必须包含至少一个浏览器证据引用。')
    }
    const evidenceRefs = [...new Set(args.evidenceRefs.map((item) => {
      if (typeof item !== 'string' || !/^\.javdex[\\/]browser[\\/][a-f0-9]{24}\.json$/u.test(item)) {
        throw new Error('候选包含无效的浏览器证据引用。')
      }
      return item.replace(/\\/gu, '/')
    }))]
    if (evidenceRefs.length > 80) throw new Error('浏览器证据引用超过 80 条上限。')
    this.browser.assertEvidenceRefs(runId, evidenceRefs)
    if (target.kind === 'video') {
      const video = getVideoById(target.id)
      if (!video) throw new Error('影片不存在。')
      const observedFields = uniqueAllowed(args.observedFields, ALL_VIDEO_SCRAPE_FIELDS, 'observedFields')
      if (observedFields.length === 0) throw new Error('影片候选至少需要一个已观察字段。')
      const explicitlyEmptyFields = uniqueAllowed(
        args.explicitlyEmptyFields,
        ALL_VIDEO_SCRAPE_FIELDS,
        'explicitlyEmptyFields'
      )
      if (typeof args.data.code !== 'string' || !args.data.code.trim()) {
        throw new Error('影片候选必须包含页面中观察到的番号。')
      }
      const result = normalizeVideoScrapeResult(args.data, video.code)
      if (!result || normalizeVideoCode(result.code) !== normalizeVideoCode(video.code)) {
        throw new Error('外部页面番号与当前影片不一致。')
      }
      result.sourceUrl = sourceUrl
      validateObservedFields({
        observed: observedFields,
        explicitlyEmpty: explicitlyEmptyFields,
        hasValue: (field) => valuesPresentForVideo(result, field)
      })
      return { kind: 'video', result, observedFields, explicitlyEmptyFields, evidenceRefs }
    }

    if (target.kind !== 'actress') return unsupportedTarget(target)

    const actress = getActressDetail(target.id)
    if (!actress) throw new Error('演员不存在。')
    const observedFields = uniqueAllowed(args.observedFields, ALL_ACTRESS_SCRAPE_FIELDS, 'observedFields')
    if (observedFields.length === 0) throw new Error('演员候选至少需要一个已观察字段。')
    const explicitlyEmptyFields = uniqueAllowed(
      args.explicitlyEmptyFields,
      ALL_ACTRESS_SCRAPE_FIELDS,
      'explicitlyEmptyFields'
    )
    const result = normalizeActressScrapeResult(args.data)
    if (!result) throw new Error('演员候选为空。')
    result.sourceUrl = sourceUrl
    const targetNames = new Set(
      [actress.main_name, ...actress.names.map((name) => name.name)].map(normalizeActressName)
    )
    const candidateNames = [result.mainName, result.nameZh, result.nameEn, ...(result.aliases ?? [])]
      .filter((name): name is string => Boolean(name?.trim()))
      .map(normalizeActressName)
    const identityMatched = args.identityMatched === true && candidateNames.some((name) => targetNames.has(name))
    validateObservedFields({
      observed: observedFields,
      explicitlyEmpty: explicitlyEmptyFields,
      hasValue: (field) => valuesPresentForActress(result, field)
    })
    return {
      kind: 'actress', result, observedFields, explicitlyEmptyFields, identityMatched, evidenceRefs
    }
  }

  private async stageResources(
    runId: string,
    payload: AgentMetadataDraftPayload,
    warnings: string[],
    signal: AbortSignal
  ): Promise<AgentMetadataDraftResource[]> {
    const pending: Array<{
      field: AgentMetadataDraftResource['field']
      position: number
      remoteUrl: string
      data: Buffer
    }> = []
    const requests: Array<{ field: AgentMetadataDraftResource['field']; position: number; remoteUrl: string }> = []
    if (payload.kind === 'video') {
      const observed = new Set(payload.observedFields)
      if (observed.has('cover') && payload.result.coverUrl) {
        requests.push({ field: 'cover', position: 0, remoteUrl: payload.result.coverUrl })
      }
      if (observed.has('samples')) {
        for (const [position, remoteUrl] of (payload.result.sampleImageUrls ?? []).entries()) {
          requests.push({ field: 'samples', position, remoteUrl })
        }
      }
      for (const [position, actress] of (payload.result.actresses ?? []).entries()) {
        const gender = actress.gender ?? 'female'
        const observedCast = gender === 'female'
          ? observed.has('actressesFemale')
          : observed.has('actressesMale')
        if (observedCast && actress.avatarUrl) {
          requests.push({ field: 'actressAvatar', position, remoteUrl: actress.avatarUrl })
        }
      }
    } else {
      const observed = new Set(payload.observedFields)
      if (observed.has('avatar') && payload.result.avatarUrl) {
        requests.push({ field: 'avatar', position: 0, remoteUrl: payload.result.avatarUrl })
      }
      if (observed.has('gallery')) {
        for (const [position, remoteUrl] of (payload.result.galleryImageUrls ?? []).entries()) {
          requests.push({ field: 'gallery', position, remoteUrl })
        }
      }
    }

    if (requests.length > 320) throw new Error('候选图片数量超过 320 张上限。')

    let totalBytes = 0
    for (const request of requests) {
      signal.throwIfAborted()
      try {
        const data = await this.browser.fetchBuffer(runId, request.remoteUrl, signal)
        if (data.byteLength > MAX_IMAGE_BYTES) throw new Error('单张图片超过 20 MiB')
        if (!mediaAssetStore.isUsableImageBuffer(data)) throw new Error('响应不是可用图片')
        if (totalBytes + data.byteLength > MAX_TOTAL_IMAGE_BYTES) {
          warnings.push('图片总量超过 200 MiB，已停止下载后续图片。')
          break
        }
        totalBytes += data.byteLength
        pending.push({ ...request, remoteUrl: sanitizeAgentMetadataUrl(request.remoteUrl), data })
      } catch (error) {
        signal.throwIfAborted()
        warnings.push(`${request.field} #${request.position + 1} 未暂存：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (payload.kind === 'video') {
      const staged = mediaAssetStore.stageVideoScrapeImages(
        pending
          .filter((item): item is typeof item & { field: 'cover' | 'samples' | 'actressAvatar' } =>
            ['cover', 'samples', 'actressAvatar'].includes(item.field)
          )
          .map((item) => ({ ...item, remoteUrl: item.remoteUrl }))
      )
      try {
        return staged.map((item) => ({
          field: item.field,
          position: item.position,
          remoteUrl: item.remoteUrl,
          stagedPath: item.stagedPath,
          width: item.width,
          height: item.height,
          sizeBytes: item.sizeBytes,
          sha256: sha256(mediaAssetStore.readVideoScrapeStagedImage(item.stagedPath))
        }))
      } catch (error) {
        this.cleanupStaging('video', staged.map((item) => item.stagedPath))
        throw error
      }
    }

    const staged = mediaAssetStore.stageActressScrapeImages(
      pending
        .filter((item): item is typeof item & { field: 'avatar' | 'gallery' } =>
          ['avatar', 'gallery'].includes(item.field)
        )
        .map((item) => ({ ...item, remoteUrl: item.remoteUrl }))
    )
    try {
      return staged.map((item) => {
        const body = mediaAssetStore.readActressScrapeStagedImage(item.stagedPath)
        return {
          field: item.field,
          position: item.position,
          remoteUrl: item.remoteUrl ?? null,
          stagedPath: item.stagedPath,
          width: item.width,
          height: item.height,
          sizeBytes: body.byteLength,
          sha256: sha256(body)
        }
      })
    } catch (error) {
      this.cleanupStaging('actress', staged.map((item) => item.stagedPath))
      throw error
    }
  }

  private buildReview(
    draft: AgentMetadataDraft,
    selection: AgentMetadataPlanInput,
    revision: number,
    forceResourceVerification = false
  ): AgentMetadataReview {
    this.assertResourceIntegrity(draft, forceResourceVerification)
    if (draft.target.kind === 'video' && draft.payload.kind === 'video' && selection.kind === 'video') {
      const observed = new Set(draft.payload.observedFields)
      if (selection.fields.some((field) => !observed.has(field))) {
        throw new Error('预览选择包含 Agent 未观察的影片字段。')
      }
      const cover = draft.resources.find((item) => item.field === 'cover')?.stagedPath ?? null
      const samples = (draft.payload.result.sampleImageUrls ?? []).map((_, position) =>
        draft.resources.find((item) => item.field === 'samples' && item.position === position)?.stagedPath ?? null
      )
      const plan = videoScrapeApplyService.plan(
        draft.target.id,
        draft.payload.result,
        cover,
        samples,
        selection.fields,
        draft.source.sourceName,
        selection.mode,
        draft.source.sourceName,
        { directorSelectionId: selection.directorSelectionId, directorAmbiguity: 'choice' }
      )
      const identityConflictVideoId = findVideoBusinessIdentityConflictForScrape(
        draft.target.id,
        draft.payload.result,
        selection.fields,
        selection.mode
      ) ?? undefined
      const normalizedSelection: Extract<AgentMetadataPlanInput, { kind: 'video' }> = {
        ...selection,
        expectedRevision: revision
      }
      const value: Omit<Extract<AgentMetadataReview, { kind: 'video' }>, 'token'> = {
        kind: 'video',
        draftId: draft.id,
        revision,
        selection: normalizedSelection,
        impacts: plan.impacts,
        warnings: [
          ...draft.warnings,
          ...plan.warnings,
          ...(identityConflictVideoId
            ? [`候选会与影片 #${identityConflictVideoId} 形成重复业务身份；确认后将转入待处理中心。`]
            : [])
        ],
        classifications: plan.classifications,
        ...(plan.directorChoice ? { directorChoice: plan.directorChoice } : {}),
        ...(identityConflictVideoId ? { identityConflictVideoId } : {}),
        canApply: !plan.directorChoice
      }
      return { ...value, token: reviewToken(value, draft.resources) }
    }

    if (draft.target.kind !== 'actress' || draft.payload.kind !== 'actress' || selection.kind !== 'actress') {
      throw new Error('草稿与预览类型不一致。')
    }
    const observed = new Set(draft.payload.observedFields)
    if (selection.fields.some((field) => !observed.has(field))) {
      throw new Error('预览选择包含 Agent 未观察的演员字段。')
    }
    const avatar = draft.resources.find((item) => item.field === 'avatar')?.stagedPath ?? null
    const gallery = draft.resources
      .filter((item) => item.field === 'gallery')
      .sort((left, right) => left.position - right.position)
      .map((item) => ({
        remoteUrl: item.remoteUrl,
        localPath: item.stagedPath,
        width: item.width,
        height: item.height
      }))
    let impacts: Extract<AgentMetadataReview, { kind: 'actress' }>['impacts'] = []
    const warnings = [...draft.warnings]
    let canApply = draft.payload.identityMatched || selection.identityConfirmed === true
    if (!draft.payload.identityMatched) {
      warnings.push('页面名称未与库内已知名称匹配；应用前必须由你确认这是同一位演员。')
    }
    const galleryComplete =
      draft.resources.filter((item) => item.field === 'gallery').length ===
      (draft.payload.result.galleryImageUrls?.length ?? 0)
    if (selection.fields.includes('gallery') && !galleryComplete) {
      canApply = false
      warnings.push('写真暂存不完整；请取消选择“写真”后应用其他字段，或重新采集。')
    }
    const effectiveFields = resolveEffectiveActressScrapeFields(
      draft.target.id,
      selection.fields,
      selection.mode
    )
    const nameConflictRecords = findActressScrapeNameConflicts(
      draft.target.id,
      effectiveFields,
      draft.payload.result
    )
    try {
      impacts = planActressScrapeResult(
        draft.target.id,
        draft.payload.result,
        avatar,
        gallery,
        selection.fields,
        selection.mode,
        { releasedNameKeys: nameConflictRecords.map((conflict) => conflict.normalizedName) }
      ).impacts
    } catch (error) {
      canApply = false
      warnings.push(error instanceof Error ? error.message : String(error))
    }
    const nameConflicts = nameConflictRecords.map((conflict) => conflict.name)
    if (nameConflicts.length > 0) {
      warnings.push(`名称 ${nameConflicts.map((name) => `「${name}」`).join('、')} 已由其他演员使用；应用时会转入待处理中心。`)
    }
    const normalizedSelection: Extract<AgentMetadataPlanInput, { kind: 'actress' }> = {
      ...selection,
      expectedRevision: revision
    }
    const value: Omit<Extract<AgentMetadataReview, { kind: 'actress' }>, 'token'> = {
      kind: 'actress',
      draftId: draft.id,
      revision,
      selection: normalizedSelection,
      impacts,
      warnings,
      ...(nameConflicts.length > 0 ? { nameConflicts } : {}),
      requiresIdentityConfirmation: !draft.payload.identityMatched,
      canApply
    }
    return { ...value, token: reviewToken(value, draft.resources) }
  }

  private applyVideo(
    draft: AgentMetadataDraft,
    stored: Extract<AgentMetadataReview, { kind: 'video' }> | AgentMetadataReview,
    input: AgentMetadataApplyInput
  ): AgentMetadataApplyOutcome {
    if (draft.payload.kind !== 'video' || stored.kind !== 'video') throw new Error('影片草稿类型无效。')
    const payload = draft.payload
    const stagedPaths = draft.resources.map((item) => item.stagedPath)
    let obsoletePendingPaths: string[] = []
    const outcome = mediaAssetStore.coordinateDatabaseChange(() =>
      getDb().transaction(() => {
        const freshDraft = this.repo.require(draft.id)
        const fresh = this.buildReview(freshDraft, stored.selection, stored.revision)
        if (fresh.kind !== 'video') throw new Error('影片预览类型无效。')
        if (fresh.token !== stored.token) throw new PreviewStaleError()
        if (fresh.identityConflictVideoId) {
          const applicableFields = [...new Set(
            fresh.impacts
              .filter((impact) => impact.action !== 'preserve')
              .map((impact) => impact.field)
          )]
          const persisted = replacePendingVideoScrape({
            videoId: draft.target.id,
            selectedFields: stored.selection.fields,
            applicableFields,
            updateMode: stored.selection.mode,
            request: {
              source: 'agent-metadata',
              sourceUrl: draft.source.displayUrl,
              fields: stored.selection.fields,
              mode: stored.selection.mode
            },
            warnings: fresh.warnings,
            sources: [{
              pluginName: 'Agent 元数据采集',
              pluginSource: 'builtin',
              pluginVersion: null,
              pluginConfig: { sourceUrl: draft.source.displayUrl },
              sourceName: draft.source.sourceName ?? 'Agent',
              selectedFields: stored.selection.fields,
              candidates: [{
                result: payload.result,
                sourceUrl: payload.result.sourceUrl ?? null,
                normalizedSourceUrl: draft.source.displayUrl,
                resources: draft.resources
                  .filter((resource) =>
                    ['cover', 'samples', 'actressAvatar'].includes(resource.field)
                  )
                  .map((resource) => ({
                    field: resource.field as 'cover' | 'samples' | 'actressAvatar',
                    position: resource.position,
                    remoteUrl: resource.remoteUrl,
                    stagedPath: resource.stagedPath,
                    width: resource.width,
                    height: resource.height,
                    sizeBytes: resource.sizeBytes
                  }))
              }]
            }]
          })
          obsoletePendingPaths = excludeRetainedStagingDirectories(
            persisted.obsoletePaths,
            draft.resources.map((resource) => resource.stagedPath)
          )
          const routed: AgentMetadataApplyOutcome = {
            status: 'routed_to_pending',
            target: draft.target,
            pendingKind: 'video',
            pendingId: persisted.pendingScrapeId,
            warnings: fresh.warnings
          }
          this.repo.completeApply({ ...input, outcome: routed })
          return routed
        }
        const hasChanges = fresh.impacts.some((impact) => impact.action !== 'preserve')
        if (!hasChanges) {
          const noOp: AgentMetadataApplyOutcome = {
            status: 'no_op', target: draft.target, warnings: fresh.warnings
          }
          this.repo.completeApply({ ...input, outcome: noOp })
          return noOp
        }
        const video = getVideoById(draft.target.id)
        if (!video) throw new Error('影片不存在。')
        const fields = new Set(stored.selection.fields)
        const coverResource = fields.has('cover')
          ? draft.resources.find((item) => item.field === 'cover')
          : undefined
        const coverPath = coverResource
          ? mediaAssetStore.importCover(video.code, mediaAssetStore.resolve(coverResource.stagedPath))
          : null
        const sampleResources = draft.resources
          .filter((item) => item.field === 'samples')
          .sort((left, right) => left.position - right.position)
        const samplePaths = fields.has('samples') &&
          sampleResources.length === (payload.result.sampleImageUrls?.length ?? 0)
          ? sampleResources.map((item) => mediaAssetStore.importSample(video.code, mediaAssetStore.resolve(item.stagedPath)))
          : (payload.result.sampleImageUrls ?? []).map(() => null)
        const actressAvatars = new Map<string, string | null>()
        if (fields.has('actressesFemale') || fields.has('actressesMale')) {
          for (const resource of draft.resources.filter((item) => item.field === 'actressAvatar')) {
            const actress: ScrapedActress | undefined = payload.result.actresses?.[resource.position]
            if (!actress?.avatarUrl) continue
            const gender = actress.gender ?? 'female'
            if (gender === 'female' && !fields.has('actressesFemale')) continue
            if (gender === 'male' && !fields.has('actressesMale')) continue
            actressAvatars.set(
              actress.name,
              mediaAssetStore.storeScrapedActressAvatar(
                actress.name,
                actress.avatarUrl,
                mediaAssetStore.readVideoScrapeStagedImage(resource.stagedPath)
              )
            )
          }
        }
        const application = videoScrapeApplyService.apply(
          draft.target.id,
          payload.result,
          coverPath,
          actressAvatars,
          samplePaths,
          stored.selection.fields,
          draft.source.sourceName,
          stored.selection.mode,
          draft.source.sourceName,
          {
            directorSelectionId: stored.selection.directorSelectionId,
            directorAmbiguity: 'choice'
          }
        )
        if (application.directorChoice) throw new PreviewStaleError()
        for (const path of application.obsoleteAssetPaths) mediaAssetStore.deleteBestEffort(path)
        const applied: AgentMetadataApplyOutcome = {
          status: application.applied ? 'applied' : 'no_op',
          target: draft.target,
          warnings: [...draft.warnings, ...application.warnings]
        }
        this.repo.completeApply({ ...input, outcome: applied })
        return applied
      })()
    )
    if (outcome.status === 'routed_to_pending') {
      this.cleanupStaging('video', obsoletePendingPaths)
    } else {
      this.cleanupStaging('video', stagedPaths)
    }
    return outcome
  }

  private applyActress(
    draft: AgentMetadataDraft,
    stored: Extract<AgentMetadataReview, { kind: 'actress' }> | AgentMetadataReview,
    input: AgentMetadataApplyInput
  ): AgentMetadataApplyOutcome {
    if (draft.payload.kind !== 'actress' || stored.kind !== 'actress') throw new Error('演员草稿类型无效。')
    const payload = draft.payload
    const stagedPaths = draft.resources.map((item) => item.stagedPath)
    let obsoletePendingPaths: string[] = []
    const outcome = mediaAssetStore.coordinateDatabaseChange(() =>
      getDb().transaction(() => {
        const freshDraft = this.repo.require(draft.id)
        const fresh = this.buildReview(freshDraft, stored.selection, stored.revision)
        if (fresh.kind !== 'actress') throw new Error('演员预览类型无效。')
        if (fresh.token !== stored.token) throw new PreviewStaleError()
        if (fresh.nameConflicts?.length) {
          const applicableFields = [...new Set(
            fresh.impacts
              .filter((impact) => impact.action !== 'preserve')
              .map((impact) => impact.field)
          )]
          const routed = actressIdentityConflictWorkflow.routeStagedScrape({
            actressId: draft.target.id,
            plugin: { name: 'Agent 元数据采集', source: 'builtin' },
            queryName: payload.result.mainName ?? getActressDetail(draft.target.id)?.main_name ?? '',
            selectedFields: stored.selection.fields,
            applicableFields,
            mode: stored.selection.mode,
            result: payload.result,
            warnings: fresh.warnings,
            resources: draft.resources
              .filter((resource) => ['avatar', 'gallery'].includes(resource.field))
              .map((resource) => ({
                field: resource.field as 'avatar' | 'gallery',
                position: resource.position,
                remoteUrl: resource.remoteUrl ?? undefined,
                stagedPath: resource.stagedPath,
                width: resource.width,
                height: resource.height
              }))
          })
          obsoletePendingPaths = excludeRetainedStagingDirectories(
            routed.obsoleteStagedPaths,
            draft.resources.map((resource) => resource.stagedPath)
          )
          const routedOutcome: AgentMetadataApplyOutcome = {
            status: 'routed_to_pending',
            target: draft.target,
            pendingKind: 'actress',
            pendingId: routed.pendingId,
            warnings: fresh.warnings
          }
          this.repo.completeApply({ ...input, outcome: routedOutcome })
          return routedOutcome
        }
        const hasChanges = fresh.impacts.some((impact) => impact.action !== 'preserve')
        if (!hasChanges) {
          const noOp: AgentMetadataApplyOutcome = {
            status: 'no_op', target: draft.target, warnings: fresh.warnings
          }
          this.repo.completeApply({ ...input, outcome: noOp })
          return noOp
        }
        const actress = getActressDetail(draft.target.id)
        if (!actress) throw new Error('演员不存在。')
        const fields = new Set(stored.selection.fields)
        const avatarResource = fields.has('avatar')
          ? draft.resources.find((item) => item.field === 'avatar')
          : undefined
        const avatarPath = avatarResource
          ? mediaAssetStore.storeScrapedActressAvatar(
              actress.main_name,
              avatarResource.remoteUrl ?? payload.result.avatarUrl ?? '',
              mediaAssetStore.readActressScrapeStagedImage(avatarResource.stagedPath)
            )
          : null
        const galleryAssets = fields.has('gallery')
          ? draft.resources
              .filter((item) => item.field === 'gallery')
              .sort((left, right) => left.position - right.position)
              .map((resource) => {
                const storedImage = mediaAssetStore.storeScrapedActressGalleryImage(
                  actress.main_name,
                  actress.id,
                  resource.remoteUrl ?? '',
                  mediaAssetStore.readActressScrapeStagedImage(resource.stagedPath)
                )
                return {
                  remoteUrl: resource.remoteUrl,
                  localPath: storedImage.localPath,
                  width: storedImage.width,
                  height: storedImage.height
                }
              })
          : []
        const application = applyActressScrapeResult(
          draft.target.id,
          payload.result,
          avatarPath,
          galleryAssets,
          stored.selection.fields,
          stored.selection.mode,
          undefined,
          { deferFileCleanup: true }
        )
        for (const path of application.fileChanges?.obsoletePaths ?? []) mediaAssetStore.deleteBestEffort(path)
        const outcome: AgentMetadataApplyOutcome = {
          status: application.applied ? 'applied' : 'no_op',
          target: draft.target,
          warnings: [...draft.warnings, ...application.warnings]
        }
        this.repo.completeApply({ ...input, outcome })
        return outcome
      })()
    )
    if (outcome.status === 'routed_to_pending') {
      this.cleanupStaging('actress', obsoletePendingPaths)
    } else {
      this.cleanupStaging('actress', stagedPaths)
    }
    return outcome
  }

  private cleanupStaging(kind: AgentMetadataTarget['kind'], stagedPaths: string[]): void {
    try {
      if (kind === 'video') mediaAssetStore.cleanupVideoScrapeStagingPaths(stagedPaths)
      else if (kind === 'actress') mediaAssetStore.cleanupActressScrapeStagingPaths(stagedPaths)
      else unsupportedTarget(kind)
    } catch (error) {
      console.error('Agent metadata staging cleanup failed:', error)
    }
  }

  private assertResourceIntegrity(draft: AgentMetadataDraft, force = false): void {
    const manifest = canonical(resourceManifest(draft.resources))
    if (!force && this.verifiedResourceManifests.get(draft.id) === manifest) return
    for (const resource of draft.resources) {
      let body: Buffer
      try {
        body = draft.target.kind === 'video'
          ? mediaAssetStore.readVideoScrapeStagedImage(resource.stagedPath)
          : mediaAssetStore.readActressScrapeStagedImage(resource.stagedPath)
      } catch {
        throw new Error('暂存图片已丢失或损坏，请丢弃草稿后重新采集。')
      }
      if (body.byteLength !== resource.sizeBytes || sha256(body) !== resource.sha256) {
        throw new Error('暂存图片已发生变化，请丢弃草稿后重新采集。')
      }
    }
    this.verifiedResourceManifests.set(draft.id, manifest)
  }
}

export const agentMetadataDraftService = new AgentMetadataDraftService()
