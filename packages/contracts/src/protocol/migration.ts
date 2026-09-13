export type MigrationPhase =
  | 'prepare'
  | 'frozen'
  | 'ready'
  | 'enableAuthorized'
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
  sourceServerId: string
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

export interface MigrationStatus {
  migrationId: string
  sourcePhase: MigrationPhase
  targetPhase: MigrationPhase
  digest: string
}
