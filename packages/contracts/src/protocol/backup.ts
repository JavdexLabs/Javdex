import { z } from 'zod'

export const BACKUP_FORMAT = 'javdex-catalog-backup'
export const BACKUP_FORMAT_VERSION = 1
export const BACKUP_MAX_BYTES = 64 * 1024 * 1024 * 1024
export const BACKUP_CHUNK_BYTES = 8 * 1024 * 1024

export const backupMappingSchema = z.object({
  sourceRootId: z.number().int().positive(),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local'), path: z.string().min(1).max(4096) }).strict(),
    z.object({ kind: z.literal('mount'), mountSelectionId: z.string().min(1).max(256), relativePath: z.string().max(1024) }).strict(),
    z.object({ kind: z.literal('omit') }).strict()
  ])
}).strict()
export type BackupMapping = z.infer<typeof backupMappingSchema>
export const backupRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('create'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('confirmMissingImages'), id: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ action: z.literal('receive'), id: z.uuid(), bytes: z.number().int().positive().max(BACKUP_MAX_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ action: z.literal('inspect'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('preview'), id: z.uuid(), mappings: z.array(backupMappingSchema).max(10000), omitUnrooted: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('restore'), id: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ action: z.literal('status'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('cancel'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('previewRemoval'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('removeRecord'), id: z.uuid(), deleteFiles: z.boolean().optional(), digest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
])
export type BackupRequest = z.infer<typeof backupRequestSchema>
export interface BackupSummary {
  format: typeof BACKUP_FORMAT
  formatVersion: number
  appVersion: string
  schemaVersion: number
  createdAt: string
  sourcePlatform: string
  sourceCatalogId: string
  counts: { libraries: number; videos: number; actresses: number; playlists: number; images: number }
  unrootedResources: number
  /** Missing source images explicitly omitted from this backup; source records are unchanged. */
  missingImages?: string[]
  roots: Array<{ id: number; libraryId: number; name: string; path: string }>
}
export interface BackupPreview {
  digest: string
  targetCounts: BackupSummary['counts']
  missingResources: number
  removedResources: number
  blockers: string[]
  automaticBackupPath: string
}
export interface BackupJob {
  id: string
  kind: 'backup' | 'restore'
  phase: 'receiving' | 'snapshot' | 'awaitingImages' | 'packing' | 'inspecting' | 'ready' | 'protecting' | 'applying' | 'completed' | 'cancelled' | 'failed' | 'recoveryRequired'
  createdAt: string
  bytes: number
  transferred: number
  sha256?: string
  summary?: BackupSummary
  /** Original backup version stays in summary; only the staged database is upgraded. */
  upgrade?: { fromSchemaVersion: number; toSchemaVersion: number }
  preview?: BackupPreview
  automaticBackupId?: string
  newCatalogId?: string
  error?: string
  fileName?: string
  savedPath?: string
  transferError?: string
  downloading?: boolean
  downloadedBytes?: number
  missingImages?: { paths: string[]; digest: string }
  progress?: { stage: 'checking' | 'database' | 'copying' | 'decrypting' | 'paths' | 'checksums' | 'packing'; completed: number; total: number; updatedAt: string }
}
export interface BackupRemovalPreview {
  digest: string
  bytes: number
  fileCount: number
  location: string
  host: 'local' | 'remote'
  automaticBackup: boolean
  retainedAutomaticBackup: boolean
  cleanupStarted?: boolean
  blockedReason?: string
}
export interface BackupResponse { jobs: BackupJob[]; removal?: BackupRemovalPreview }
export const desktopBackupFileSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create') }).strict(),
  z.object({ action: z.literal('open') }).strict(),
  z.object({ action: z.literal('importLocal') }).strict(),
  z.object({ action: z.literal('save'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('resume'), id: z.uuid() }).strict(),
  z.object({ action: z.literal('pickDirectory') }).strict(),
  z.object({ action: z.literal('reveal'), id: z.uuid() }).strict()
])
export type DesktopBackupFileRequest = z.infer<typeof desktopBackupFileSchema>
export interface DesktopBackupFileResult { job?: BackupJob; path?: string; cancelled?: boolean }
