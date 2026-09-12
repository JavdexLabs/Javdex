import type { DesktopCapabilityMap } from '@shared/desktop/capabilities'
import type { DesktopSession } from '@shared/desktop/session'
import type { ManageOperationInput } from '@shared/manage/inputs'
import type { HandshakeResult } from '@shared/protocol/handshake'
import type { CatalogIdentity } from '@shared/protocol/identity'
import type { ExpectedVersions } from '@shared/protocol/versions'
import type { WriterClaimInput, WriterClaimResult, WriterStatus } from '@shared/protocol/writer'
import type { StructuredError } from '@shared/protocol/errors'

export interface MutationContext {
  operationId: string
  expectedVersions: ExpectedVersions
  signal?: AbortSignal
}

export interface CatalogQueryContext {
  signal?: AbortSignal
}

/* Existing domain objects and IPC extras until S08 projects manage DTOs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CatalogPortInput = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CatalogPortValue = any

type Query<_K extends keyof ManageOperationInputMap> = (
  input: CatalogPortInput,
  ctx?: CatalogQueryContext
) => Promise<CatalogPortValue>
type Command<_K extends keyof ManageOperationInputMap> = (
  input: CatalogPortInput,
  ctx: MutationContext
) => Promise<CatalogPortValue>
type ManageOperationInputMap = { [K in import('@shared/manage/operations').ManageOperationId]: ManageOperationInput<K> }

export interface CatalogQueries {
  homeLoad: Query<'home.load'>
  homeSearch: Query<'home.search'>
  listVideos: Query<'videos.list'>
  getVideo: Query<'videos.get'>
  listVideoYears: Query<'videos.years'>
  getResource: Query<'videos.getResource'>
  listTags: Query<'tags.list'>
  listManualTags: Query<'tags.listManual'>
  tagLabels: Query<'tags.labels'>
  tagFilterOptions: Query<'tags.filterOptions'>
  tagManualOptions: Query<'tags.manualOptions'>
  overviewStats: Query<'catalog.overviewStats'>
}

export interface CatalogVideoCommands {
  edit: Command<'videos.edit'>
  clearMeta: Command<'videos.clearMeta'>
  markScrapeSuccess: Command<'videos.markScrapeSuccess'>
  setRating: Command<'videos.setRating'>
  setPoster: Command<'videos.setPoster'>
  importSamples: Command<'videos.importSamples'>
  deleteSample: Command<'videos.deleteSample'>
  addManualTag: Command<'videos.addManualTag'>
  addExistingManualTag: Command<'videos.addExistingManualTag'>
  removeManualTag: Command<'videos.removeManualTag'>
  correctImport: Command<'videos.correctImport'>
  importResource: Command<'videos.importResource'>
  updateResource: Command<'videos.updateResource'>
  updateLocalResourceLabel: Command<'videos.updateLocalResourceLabel'>
  setPrimaryResource: Command<'videos.setPrimaryResource'>
  removeResource: Command<'videos.removeResource'>
  previewRemoveFromLibrary: Query<'videos.previewRemoveFromLibrary'>
  removeFromLibrary: Command<'videos.removeFromLibrary'>
  previewMoveResource: Query<'videos.previewMoveResource'>
  moveResource: Command<'videos.moveResource'>
  previewDeleteGlobal: Query<'videos.previewDeleteGlobal'>
  deleteGlobal: Command<'videos.deleteGlobal'>
  merge: Command<'videos.merge'>
  splitResource: Command<'videos.splitResource'>
  applyScrapeCandidate: Command<'videos.applyScrapeCandidate'>
}

export interface CatalogActressCommands {
  list: Query<'actresses.list'>
  listPage: Query<'actresses.listPage'>
  pickerPage: Query<'actresses.pickerPage'>
  pickerGet: Query<'actresses.pickerGet'>
  get: Query<'actresses.get'>
  profile: Query<'actresses.profile'>
  metadata: Query<'actresses.metadata'>
  videoPage: Query<'actresses.videoPage'>
  galleryPage: Query<'actresses.galleryPage'>
  avatarSourceInfo: Query<'actresses.avatarSourceInfo'>
  mergeCandidates: Query<'actresses.mergeCandidates'>
  edit: Command<'actresses.edit'>
  delete: Command<'actresses.delete'>
  deleteBatch: Command<'actresses.deleteBatch'>
  deletePreview: Query<'actresses.deletePreview'>
  clearMeta: Command<'actresses.clearMeta'>
  importGallery: Command<'actresses.importGallery'>
  deleteGallery: Command<'actresses.deleteGallery'>
  setPoster: Command<'actresses.setPoster'>
  merge: Command<'actresses.merge'>
  markScrapeSuccess: Command<'actresses.markScrapeSuccess'>
  applyCrop: Command<'actresses.applyCrop'>
  applyScrapeCandidate: Command<'actresses.applyScrapeCandidate'>
  testTargetPage: Query<'actresses.testTargetPage'>
  conflictList: Query<'actressConflicts.list'>
  conflictQueuePage: Query<'actressConflicts.queuePage'>
  conflictGet: Query<'actressConflicts.get'>
  conflictCount: Query<'actressConflicts.count'>
  conflictSummary: Query<'actressConflicts.summary'>
  inspectName: Query<'actressConflicts.inspectName'>
  discardConflict: Command<'actressConflicts.discard'>
  validateIllegal: Command<'actressConflicts.validateIllegal'>
  resolveConflict: Command<'actressConflicts.resolve'>
}

export interface CatalogClassificationCommands {
  listOrganizations: Query<'organizations.list'>
  pageOrganizations: Query<'organizations.page'>
  getOrganization: Query<'organizations.get'>
  createOrganization: Command<'organizations.create'>
  updateOrganization: Command<'organizations.update'>
  mergeOrganizations: Command<'organizations.merge'>
  deleteOrganization: Command<'organizations.delete'>
  organizationOptions: Query<'organizations.options'>
  organizationMergeOptions: Query<'organizations.mergeOptions'>
  organizationRoleRemovePreview: Query<'organizations.roleRemovePreview'>
  organizationRoleRemove: Command<'organizations.roleRemove'>
  organizationDeletePreview: Query<'organizations.deletePreview'>
  listDirectors: Query<'directors.list'>
  pageDirectors: Query<'directors.page'>
  getDirector: Query<'directors.get'>
  createDirector: Command<'directors.create'>
  updateDirector: Command<'directors.update'>
  mergeDirectors: Command<'directors.merge'>
  deleteDirector: Command<'directors.delete'>
  directorOptions: Query<'directors.options'>
  directorDeletePreview: Query<'directors.deletePreview'>
  listSeries: Query<'series.list'>
  pageSeries: Query<'series.page'>
  getSeries: Query<'series.get'>
  createSeries: Command<'series.create'>
  updateSeries: Command<'series.update'>
  mergeSeries: Command<'series.merge'>
  deleteSeries: Command<'series.delete'>
  seriesOptions: Query<'series.options'>
  seriesDeletePreview: Query<'series.deletePreview'>
  imagePage: Query<'classificationImages.page'>
  imageCandidates: Query<'classificationImages.candidates'>
  setImage: Command<'classificationImages.set'>
}

export interface CatalogPlaylistCommands {
  list: Query<'playlists.list'>
  listPage: Query<'playlists.listPage'>
  get: Query<'playlists.get'>
  getPage: Query<'playlists.getPage'>
  metadata: Query<'playlists.metadata'>
  videoPage: Query<'playlists.videoPage'>
  listForVideo: Query<'playlists.listForVideo'>
  create: Command<'playlists.create'>
  update: Command<'playlists.update'>
  delete: Command<'playlists.delete'>
  addVideo: Command<'playlists.addVideo'>
  removeVideo: Command<'playlists.removeVideo'>
  applyImport: Command<'playlists.applyImport'>
}

export interface CatalogLibraryCommands {
  list: Query<'libraries.list'>
  get: Query<'libraries.get'>
  create: Command<'libraries.create'>
  update: Command<'libraries.update'>
  updateConfig: Command<'libraries.updateConfig'>
  addRoot: Command<'libraries.addRoot'>
  updateRoot: Command<'libraries.updateRoot'>
  removeRoot: Command<'libraries.removeRoot'>
  cancelRootRemoval: Command<'libraries.cancelRootRemoval'>
  archive: Command<'libraries.archive'>
  restore: Command<'libraries.restore'>
  deletePreview: Query<'libraries.deletePreview'>
  delete: Command<'libraries.delete'>
  runScan: Command<'scans.run'>
  cancelScan: Command<'scans.cancel'>
  latestScan: Query<'scans.getLatest'>
  renameFile: Command<'files.rename'>
  importManual: Command<'files.importManual'>
  resolvePendingScan: Command<'pendingScan.resolve'>
  resolveResourceIdentity: Command<'pendingResourceIdentity.resolve'>
}

export interface CatalogNfoCommands {
  getOptions: Query<'nfo.getOptions'>
  updatePreferences: Command<'nfo.updatePreferences'>
  plan: Command<'nfo.plan'>
  discardPlan: Command<'nfo.discardPlan'>
  start: Command<'nfo.start'>
  terminate: Command<'nfo.terminate'>
  state: Query<'nfo.state'>
}

export interface CatalogBrowserCommands {
  status: Query<'browser.status'>
  setEnabled: Command<'browser.setEnabled'>
  pairOpen: Command<'browser.pairOpen'>
  pairInspect: Query<'browser.pairInspect'>
  pairDecide: Command<'browser.pairDecide'>
  deviceRemove: Command<'browser.deviceRemove'>
  deviceRename: Command<'browser.deviceRename'>
  deviceReset: Command<'browser.deviceReset'>
  revokeSessions: Command<'browser.revokeSessions'>
}

export interface CatalogTaskCommands {
  get: Query<'tasks.get'>
  list: Query<'tasks.list'>
  cancel: Command<'tasks.cancel'>
  getOperation: Query<'operations.get'>
  createTargetList: Command<'targetLists.create'>
  pageTargetList: Query<'targetLists.page'>
}

export interface CatalogAssetCommands {
  createUpload: Command<'uploads.create'>
  inspectUpload: Query<'uploads.inspect'>
  grantPlayback: Query<'play.grant'>
}

export interface CatalogMigrationCommands {
  preview: Query<'migration.preview'>
  start: Command<'migration.start'>
  status: Query<'migration.status'>
  allowEnable: Command<'migration.allowEnable'>
  enable: Command<'migration.enable'>
  abandon: Command<'migration.abandon'>
}

export interface CatalogBackend {
  readonly mode: 'local' | 'remote'
  readonly identity: CatalogIdentity
  readonly generation: number
  capabilities(): DesktopCapabilityMap
  session(): DesktopSession
  queries: CatalogQueries
  videos: CatalogVideoCommands
  actresses: CatalogActressCommands
  classifications: CatalogClassificationCommands
  playlists: CatalogPlaylistCommands
  libraries: CatalogLibraryCommands
  nfo: CatalogNfoCommands
  browser: CatalogBrowserCommands
  tasks: CatalogTaskCommands
  assets: CatalogAssetCommands
  migration: CatalogMigrationCommands
  dispose(): Promise<void>
}

export interface RemoteWriterPort {
  status(): Promise<WriterStatus>
  claim(input: WriterClaimInput): Promise<WriterClaimResult>
}

export interface RemoteConnectionPort {
  handshake(): Promise<HandshakeResult>
  writer: RemoteWriterPort
}

export type CatalogCommandResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: StructuredError }
