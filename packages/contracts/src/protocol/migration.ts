export type MigrationPhase =
  | 'prepare'
  | 'frozen'
  | 'ready'
  | 'enabled'
  | 'abandoned'

export interface RootMapping {
  sourceRootId: number
  targetMountSelectionId: string
}

export interface MigrationPreviewInput {
  mappings: RootMapping[]
}

export interface MigrationPreview {
  migrationId: string
  sourceServerId: string | null
  sourceCatalogId: string
  schemaVersion: number
  appVersion: string
  localResourceRemovals: number
  strmConversions: number
  strmConflicts: Array<{ libraryId: number; resourceIds: number[] }>
  omittedRoots: Array<{ rootId: number; name: string }>
  autoCleanupDisabledLibraryIds: number[]
  pendingBlockers: string[]
  digest: string
}

export interface MigrationControlInput {
  migrationId: string
  digest: string
}

export interface MigrationAbandonInput extends MigrationControlInput {
  /** Required only when resuming a frozen source; no peer state is inferred. */
  confirmTargetStopped?: boolean
}

export interface MigrationEnableInput extends MigrationControlInput {
  /** Operator confirmation, not a claim about remotely verified peer state. */
  confirmSourceStopped: true
}

export interface MigrationStatus {
  migrationId: string
  role: 'source' | 'target'
  phase: MigrationPhase
  digest: string
}
