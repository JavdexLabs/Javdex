export type PlaylistImportDestination =
  | { kind: 'create'; requestedName?: string }
  | { kind: 'append'; playlistId: number }

export interface PlaylistImportStartInput {
  idempotencyKey: string
  sourceUrl: string
  targetLibraryId: number
  destination: PlaylistImportDestination
  /** Defaults to true when callers omit the foreground-session option. */
  autoCreateUnmatchedVideos?: boolean
  /** Defaults to true when callers omit the foreground-session option. */
  saveDetailLinks?: boolean
  /** Defaults to false; saves the imported external playlist URL on the destination playlist. */
  saveSourcePlaylistLink?: boolean
}

export type PlaylistImportPhase =
  | 'discovering-list'
  | 'resolving-identities'
  | 'waiting_user'
  | 'ready-to-apply'
  | 'applying'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface PlaylistImportProgress {
  pagesRead: number
  scrollWindowsRead: number
  knownPageTotal?: number
  sourceItems: number
  uniqueItems: number
  directReuses: number
  detailPending: number
  userDecisionsPending: number
  plannedCreates: number
  skippedItems: number
  appliedItems: number
}

export interface PlaylistImportIdentityCandidate {
  videoId: number
  code: string
  title?: string
  publisher?: string
  releaseDate?: string
  libraryIds: number[]
  libraryNames: string[]
  belongsToTargetLibrary: boolean
  resourceKinds: string[]
  relatedLinks: Array<{ label: string; url: string }>
}

export interface PlaylistImportIdentityReviewItem {
  itemId: number
  itemRevision: number
  code?: string
  title?: string
  detailUrl: string
  conflict?:
    | {
        kind: 'code-mismatch'
        listCode: string
        detailCode: string
      }
    | { kind: 'sensitive-detail-url' }
  candidates: PlaylistImportIdentityCandidate[]
}

export interface PlaylistImportOutcome {
  playlistId: number
  playlistName: string
  targetLibraryId: number
  targetLibraryName: string
  pagesRead: number
  sourceItems: number
  uniqueDetailUrls: number
  totalItems: number
  reusedVideos: number
  directReuses: number
  detailReuses: number
  userSelectedReuses: number
  crossLibraryReuses: number
  createdVideos: number
  targetLibraryMembersCreated: number
  skippedVideos: number
  addedToPlaylist: number
  alreadyInPlaylist: number
  relatedLinksAdded: number
  playlistRelatedLinksAdded: number
  externalDuplicateItems: number
  convergedExternalItems: number
  reuseLibraryDistribution: Array<{
    libraryId: number
    libraryName: string
    reusedVideos: number
  }>
}

export type PlaylistImportActivity =
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

export type PlaylistImportPreviewItemState =
  | 'discovered'
  | 'needs-detail'
  | 'needs-user'
  | 'planned-reuse'
  | 'planned-create'
  | 'applied'
  | 'failed'

export interface PlaylistImportPreviewItem {
  itemId: number
  sourcePosition: number
  code?: string
  title?: string
  detailUrl: string
  state: PlaylistImportPreviewItemState
  errorCode?: string
  resolutionKind?: string
  resolvedVideo?: { id: number; code: string; title?: string }
}

export interface PlaylistImportPreview {
  items: PlaylistImportPreviewItem[]
  totalItems: number
  truncated: boolean
}

export interface PlaylistImportSnapshot {
  runId: string
  revision: number
  cursor: number
  phase: PlaylistImportPhase
  summary: string
  frozenInput: {
    sourceUrl: string
    displayUrl: string
    sourceHost: string
    targetLibraryId: number
    targetLibraryNameAtStart: string
    destination: PlaylistImportDestination
    autoCreateUnmatchedVideos: boolean
    saveDetailLinks: boolean
    saveSourcePlaylistLink: boolean
    destinationPlaylistNameAtStart?: string
    policyVersion: 1
  }
  progress: PlaylistImportProgress
  /** Bounded live projection for the two-pane result preview. */
  preview?: PlaylistImportPreview
  /** Runtime activity is persisted in agent_runs, outside the import staging transaction. */
  activities?: PlaylistImportActivity[]
  attention?:
    | {
        kind: 'browser-handoff'
        requestId: string
        reason: 'login' | 'human_verification' | 'required_user_action'
        prompt: string
      }
    | { kind: 'identity-review'; items: PlaylistImportIdentityReviewItem[] }
  outcome?: PlaylistImportOutcome
  error?: { code: string; message: string; retryable: boolean }
}

export interface PlaylistImportSnapshotChangedEvent {
  runId: string
  revision: number
}

export type PlaylistImportControlCommand =
  | { kind: 'resume-browser'; requestId: string; idempotencyKey: string }
  | { kind: 'retry'; expectedRevision: number; idempotencyKey: string }
  | {
      kind: 'resolve-identities'
      expectedRevision: number
      idempotencyKey: string
      decisions: Array<{
        itemId: number
        choice: { kind: 'existing'; videoId: number } | { kind: 'create' }
      }>
    }
  | { kind: 'cancel'; idempotencyKey: string }

export interface PlaylistImportModule {
  start(input: PlaylistImportStartInput): Promise<PlaylistImportSnapshot>
  snapshot(runId?: string): PlaylistImportSnapshot | null
  control(runId: string, command: PlaylistImportControlCommand): Promise<PlaylistImportSnapshot>
  subscribe(listener: (event: PlaylistImportSnapshotChangedEvent) => void): () => void
}
