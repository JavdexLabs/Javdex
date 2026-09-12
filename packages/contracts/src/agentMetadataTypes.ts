import type {
  ActressScrapeField,
  ActressScrapeFieldImpact,
  ActressScrapeResult,
  ActressScrapeUpdateMode
} from './actressScrapeTypes'
import type {
  ScrapeResult,
  VideoClassificationResolutionOutcome,
  VideoDirectorChoiceRequired,
  VideoScrapeField,
  VideoScrapeUpdateMode
} from './videoScrapeTypes'

export type AgentMetadataTarget =
  | { kind: 'video'; id: number }
  | { kind: 'actress'; id: number }

export type AgentMetadataTargetKind = AgentMetadataTarget['kind']

export interface AgentMetadataStartInput {
  target: AgentMetadataTarget
  sourceUrl: string
  idempotencyKey: string
}

export type AgentMetadataPhase =
  | 'collecting'
  | 'waiting_user'
  | 'preparing'
  | 'ready'
  | 'applying'
  | 'applied'
  | 'routed_to_pending'
  | 'failed'
  | 'cancelled'
  | 'discarded'

export interface AgentMetadataBrowserHandoff {
  requestId: string
  reason: 'human_verification' | 'login' | 'required_user_action'
  prompt: string
  url?: string
  title?: string
}

export interface AgentMetadataSource {
  requestedUrl: string
  finalUrl?: string
  displayUrl: string
  sourceName?: string
  pageTitle?: string
}

export type AgentMetadataActivity =
  | {
      id: string
      kind: 'reasoning'
      status: 'running' | 'success'
      turn: number
      text: string
      charCount: number
      truncated: boolean
    }
  | {
      id: string
      kind: 'action'
      status: 'running' | 'success' | 'error'
      tool: string
      label: string
      summary?: string
    }

export interface AgentMetadataDraftResource {
  field: 'cover' | 'samples' | 'actressAvatar' | 'avatar' | 'gallery'
  position: number
  remoteUrl: string | null
  stagedPath: string
  width: number | null
  height: number | null
  sizeBytes: number
  sha256: string
}

export interface AgentMetadataVideoDraft {
  kind: 'video'
  result: ScrapeResult
  observedFields: VideoScrapeField[]
  explicitlyEmptyFields: VideoScrapeField[]
  evidenceRefs: string[]
}

export interface AgentMetadataActressDraft {
  kind: 'actress'
  result: ActressScrapeResult
  observedFields: ActressScrapeField[]
  explicitlyEmptyFields: ActressScrapeField[]
  identityMatched: boolean
  evidenceRefs: string[]
}

export type AgentMetadataDraftPayload =
  | AgentMetadataVideoDraft
  | AgentMetadataActressDraft

export interface AgentMetadataDraft {
  id: string
  runId: string | null
  target: AgentMetadataTarget
  revision: number
  status: 'ready' | 'applied' | 'routed_to_pending' | 'discarded' | 'failed'
  source: AgentMetadataSource
  payload: AgentMetadataDraftPayload
  resources: AgentMetadataDraftResource[]
  warnings: string[]
  createdAt: string
  updatedAt: string
}

export type AgentMetadataPlanInput =
  | {
      kind: 'video'
      draftId: string
      expectedRevision: number
      fields: VideoScrapeField[]
      mode: VideoScrapeUpdateMode
      directorSelectionId?: number
    }
  | {
      kind: 'actress'
      draftId: string
      expectedRevision: number
      fields: ActressScrapeField[]
      mode: ActressScrapeUpdateMode
      identityConfirmed?: boolean
    }

export interface AgentMetadataVideoReview {
  kind: 'video'
  draftId: string
  revision: number
  token: string
  selection: Extract<AgentMetadataPlanInput, { kind: 'video' }>
  impacts: Array<{
    field: VideoScrapeField
    action: 'set' | 'replace' | 'clear' | 'preserve'
    reason: string
    currentValue: unknown
    nextValue: unknown
    sourceName?: string
  }>
  warnings: string[]
  classifications: VideoClassificationResolutionOutcome[]
  directorChoice?: VideoDirectorChoiceRequired
  identityConflictVideoId?: number
  canApply: boolean
}

export interface AgentMetadataActressReview {
  kind: 'actress'
  draftId: string
  revision: number
  token: string
  selection: Extract<AgentMetadataPlanInput, { kind: 'actress' }>
  impacts: ActressScrapeFieldImpact[]
  warnings: string[]
  nameConflicts?: string[]
  requiresIdentityConfirmation: boolean
  canApply: boolean
}

export type AgentMetadataReview = AgentMetadataVideoReview | AgentMetadataActressReview

export interface AgentMetadataApplyInput {
  draftId: string
  reviewToken: string
  idempotencyKey: string
}

export type AgentMetadataApplyOutcome =
  | {
      status: 'applied' | 'no_op'
      target: AgentMetadataTarget
      warnings: string[]
    }
  | {
      status: 'routed_to_pending'
      target: AgentMetadataTarget
      pendingKind: 'video' | 'actress'
      pendingId: number
      warnings: string[]
    }
  | {
      status: 'preview_stale'
      target: AgentMetadataTarget
      review: AgentMetadataReview
      warnings: string[]
    }

export interface AgentMetadataSnapshot {
  runId: string
  revision: number
  cursor: number
  target: AgentMetadataTarget
  phase: AgentMetadataPhase
  summary: string
  source: AgentMetadataSource
  activities: AgentMetadataActivity[]
  draft?: AgentMetadataDraft
  handoff?: AgentMetadataBrowserHandoff
  errorCode?: string
}

export interface AgentMetadataSnapshotChangedEvent {
  runId: string
  revision: number
}

export interface AgentMetadataResumeInput {
  runId: string
  requestId: string
  idempotencyKey: string
}

export interface AgentMetadataDiscardInput {
  draftId: string
  expectedRevision: number
}
