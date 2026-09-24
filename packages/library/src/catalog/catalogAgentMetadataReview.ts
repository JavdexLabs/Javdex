import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  AgentMetadataCandidateTransfer,
  AgentMetadataDraft,
  AgentMetadataPlanInput,
  AgentMetadataReview
} from '@shared/agentMetadataTypes'
import type { ExpectedVersions } from '@shared/protocol/versions'
import { structuredError } from '@shared/protocol/errors'
import { getDb } from '@library/db/database'
import { getPendingVideoScrapeForVideo } from '@library/db/pendingVideoScrapeRepo'
import {
  findVideoBusinessIdentityConflictForScrape,
  planVideoScrapeResult
} from './videoScrapeApplyService'
import {
  planActressScrapeResultWithAvailability,
  resolveEffectiveActressScrapeFields
} from './actressAssetService'
import { findActressScrapeNameConflicts } from './actressIdentityConflictWorkflow'
import {
  readActressAggregateVersion,
  readVideoAggregateVersion
} from './catalogAggregateVersion'

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

export function agentMetadataCandidateFromDraft(draft: AgentMetadataDraft): AgentMetadataCandidateTransfer {
  return {
    draftId: draft.id,
    target: draft.target,
    revision: draft.revision,
    source: draft.source,
    payload: draft.payload,
    resources: draft.resources.map(({ stagedPath: _stagedPath, ...resource }) => resource),
    warnings: draft.warnings
  }
}

function reviewToken(
  candidate: AgentMetadataCandidateTransfer,
  review: Omit<AgentMetadataReview, 'token'>
): string {
  const { revision: _revision, ...candidateContent } = candidate
  return createHash('sha256')
    .update(canonical({ candidate: candidateContent, review }))
    .digest('base64url')
}

function assertSelection(candidate: AgentMetadataCandidateTransfer, selection: AgentMetadataPlanInput): void {
  if (candidate.draftId !== selection.draftId || candidate.revision !== selection.expectedRevision) {
    throw structuredError('VERSION_CONFLICT', '草稿已更新，请重新加载。')
  }
  if (candidate.target.kind !== selection.kind || candidate.payload.kind !== selection.kind) {
    throw structuredError('INVALID_INPUT', '草稿与预览类型不一致。')
  }
}

export function agentMetadataPreviewVersions(
  candidate: AgentMetadataCandidateTransfer,
  database: Database.Database = getDb()
): ExpectedVersions {
  const versions: ExpectedVersions = {}
  if (candidate.target.kind === 'video') {
    const version = readVideoAggregateVersion(candidate.target.id, database)
    if (version) versions.V = version
    const pending = getPendingVideoScrapeForVideo(candidate.target.id)
    if (pending) versions.Q = { generation: 1, revision: pending.revision }
  } else {
    const version = readActressAggregateVersion(candidate.target.id, database)
    if (version) versions.A = version
    const pending = database
      .prepare('SELECT revision FROM pending_actress_scrapes WHERE actress_id = ?')
      .get(candidate.target.id) as { revision: number } | undefined
    if (pending) versions.Q = { generation: 1, revision: pending.revision }
  }
  return versions
}

export function buildAgentMetadataReview(
  candidate: AgentMetadataCandidateTransfer,
  selection: AgentMetadataPlanInput,
  revision = selection.expectedRevision + 1,
  options: { includeVersions?: boolean } = {}
): AgentMetadataReview {
  assertSelection(candidate, selection)
  const previewVersions = options.includeVersions ? agentMetadataPreviewVersions(candidate) : undefined
  if (candidate.target.kind === 'video' && candidate.payload.kind === 'video' && selection.kind === 'video') {
    const observed = new Set(candidate.payload.observedFields)
    if (selection.fields.some((field) => !observed.has(field))) {
      throw structuredError('INVALID_INPUT', '预览选择包含 Agent 未观察的影片字段。')
    }
    const cover = candidate.resources.some((item) => item.field === 'cover')
      ? 'desktop-upload-pending'
      : null
    const samples = (candidate.payload.result.sampleImageUrls ?? []).map((_, position) =>
      candidate.resources.some((item) => item.field === 'samples' && item.position === position)
        ? `desktop-upload-pending-${position}`
        : null
    )
    const plan = planVideoScrapeResult(
      candidate.target.id,
      candidate.payload.result,
      cover,
      samples,
      selection.fields,
      candidate.source.sourceName,
      selection.mode,
      candidate.source.sourceName,
      { directorSelectionId: selection.directorSelectionId, directorAmbiguity: 'choice' }
    )
    const identityConflictVideoId = findVideoBusinessIdentityConflictForScrape(
      candidate.target.id,
      candidate.payload.result,
      selection.fields,
      selection.mode
    ) ?? undefined
    const normalizedSelection: Extract<AgentMetadataPlanInput, { kind: 'video' }> = {
      ...selection,
      expectedRevision: revision
    }
    const value: Omit<Extract<AgentMetadataReview, { kind: 'video' }>, 'token'> = {
      kind: 'video',
      draftId: candidate.draftId,
      revision,
      ...(previewVersions ? { previewVersions } : {}),
      selection: normalizedSelection,
      impacts: plan.impacts,
      warnings: [
        ...candidate.warnings,
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
    return { ...value, token: reviewToken(candidate, value) }
  }

  if (candidate.target.kind !== 'actress' || candidate.payload.kind !== 'actress' || selection.kind !== 'actress') {
    throw structuredError('INVALID_INPUT', '草稿与预览类型不一致。')
  }
  const observed = new Set(candidate.payload.observedFields)
  if (selection.fields.some((field) => !observed.has(field))) {
    throw structuredError('INVALID_INPUT', '预览选择包含 Agent 未观察的演员字段。')
  }
  const galleryResources = candidate.resources
    .filter((item) => item.field === 'gallery')
    .sort((left, right) => left.position - right.position)
  const galleryComplete = galleryResources.length === (candidate.payload.result.galleryImageUrls?.length ?? 0)
  const warnings = [...candidate.warnings]
  let canApply = candidate.payload.identityMatched || selection.identityConfirmed === true
  if (!candidate.payload.identityMatched) {
    warnings.push('页面名称未与库内已知名称匹配；应用前必须由你确认这是同一位演员。')
  }
  if (selection.fields.includes('gallery') && !galleryComplete) {
    canApply = false
    warnings.push('写真暂存不完整；请取消选择“写真”后应用其他字段，或重新采集。')
  }
  const effectiveFields = resolveEffectiveActressScrapeFields(
    candidate.target.id,
    selection.fields,
    selection.mode
  )
  const nameConflictRecords = findActressScrapeNameConflicts(
    candidate.target.id,
    effectiveFields,
    candidate.payload.result
  )
  let impacts: Extract<AgentMetadataReview, { kind: 'actress' }>['impacts'] = []
  try {
    impacts = planActressScrapeResultWithAvailability(
      candidate.target.id,
      candidate.payload.result,
      {
        avatarAvailable: candidate.resources.some((item) => item.field === 'avatar'),
        gallery: galleryResources.map((resource) => ({
          remoteUrl: resource.remoteUrl,
          localPath: `desktop-upload-pending-${resource.position}`,
          width: resource.width,
          height: resource.height
        }))
      },
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
    draftId: candidate.draftId,
    revision,
    ...(previewVersions ? { previewVersions } : {}),
    selection: normalizedSelection,
    impacts,
    warnings,
    ...(nameConflicts.length > 0 ? { nameConflicts } : {}),
    requiresIdentityConfirmation: !candidate.payload.identityMatched,
    canApply
  }
  return { ...value, token: reviewToken(candidate, value) }
}
