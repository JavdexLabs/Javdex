import type { VideoEditInput, VideoSampleImportInput } from '@shared/videoTypes'
import type { ScrapeResult, VideoScrapeField } from '@shared/videoScrapeTypes'
import type {
  ActressEditInput,
  ActressGalleryImportInput,
  ActressListQuery,
  ActressMergeInput
} from '@shared/actressTypes'
import type { ActressScrapeField, ActressScrapeResult } from '@shared/actressScrapeTypes'
import type {
  InspectActressConflictNameInput,
  ResolveActressConflictInput,
  ValidateIllegalNameReplacementsInput
} from '@shared/actressConflictTypes'
import type {
  ClassificationEntityRef,
  ClassificationImageInput,
  OrganizationRole
} from '@shared/classificationTypes'
import type {
  PlaylistCreateInput,
  PlaylistUpdateInput,
  PlaylistVideoSortBy
} from '@shared/playlistTypes'
import type { SortDir } from '@shared/commonTypes'
import type {
  AddMediaLibraryRootInput,
  DeleteMediaLibraryInput,
  RemoveMediaLibraryRootInput,
  UpdateMediaLibraryInput,
  UpdateMediaLibraryRootInput
} from '@shared/mediaLibraryIpcContract'
import type { UploadCreateInput } from '@shared/protocol/uploads'

import type { z } from 'zod'
import type { MANAGE_OPERATION_INPUTS } from '@shared/manage/inputs'
import type { ManageOperationId } from '@shared/manage/operations'
/** Before schema defaults are applied; this remains the wire-only input contract. */
export type CatalogWireInput<K extends ManageOperationId> = K extends ManageOperationId
  ? keyof z.input<(typeof MANAGE_OPERATION_INPUTS)[K]> extends never
    ? Record<string, never>
    : z.input<(typeof MANAGE_OPERATION_INPUTS)[K]>
  : never
/** Desktop-only fields are declared here, never added to the strict HTTP schemas. */
type LocalPlan<K extends ManageOperationId> = Omit<CatalogWireInput<K>, 'planId' | 'planDigest'> & {
  planId?: string
  planDigest?: string
  operationId?: string
  expectedRevision?: string
}
export interface CatalogDesktopInputs {
  'videos.edit': {
    videoId: number
    fields: CatalogWireInput<'videos.edit'>['fields'] & VideoEditInput
  }
  'videos.setPoster': CatalogWireInput<'videos.setPoster'> & {
    posterPath?: string | null
  }
  'videos.importSamples': CatalogWireInput<'videos.importSamples'> | ({
    videoId: number
    images?: never[]
  } & VideoSampleImportInput)
  'videos.removeFromLibrary': LocalPlan<'videos.removeFromLibrary'>
  'videos.moveResource': LocalPlan<'videos.moveResource'>
  'videos.deleteGlobal': LocalPlan<'videos.deleteGlobal'>
  'videos.applyScrapeCandidate': Omit<CatalogWireInput<'videos.applyScrapeCandidate'>, 'fields' | 'candidate'> & {
    fields: VideoScrapeField[]
    candidate: ScrapeResult
  }
  'actresses.listPage': ActressListQuery
  'actresses.edit': {
    actressId: number
    fields: ActressEditInput
  }
  'actresses.setPoster': CatalogWireInput<'actresses.setPoster'> & {
    posterPath?: string | null
  }
  'actresses.importGallery': CatalogWireInput<'actresses.importGallery'> | ({
    actressId: number
    images?: never[]
  } & ActressGalleryImportInput)
  'actresses.merge': CatalogWireInput<'actresses.merge'> | ActressMergeInput
  'actresses.applyScrapeCandidate': Omit<CatalogWireInput<'actresses.applyScrapeCandidate'>, 'fields' | 'candidate'> & {
    fields?: ActressScrapeField[]
    candidate: ActressScrapeResult
  }
  'actressConflicts.submit': Omit<CatalogWireInput<'actressConflicts.submit'>, 'selectedFields' | 'applicableFields'> & {
    selectedFields: ActressScrapeField[]
    applicableFields: ActressScrapeField[]
  }
  'actressConflicts.get': {
    pendingId: number
    normalizedName?: string
  } | {
    normalizedName: string
    pendingId?: number
  }
  'actressConflicts.inspectName': InspectActressConflictNameInput
  'actressConflicts.discard': CatalogWireInput<'actressConflicts.discard'> & {
    expectedRevision?: number
  }
  'actressConflicts.validateIllegal': ValidateIllegalNameReplacementsInput
  'actressConflicts.resolve': ResolveActressConflictInput
  'organizations.get': CatalogWireInput<'organizations.get'> & {
    role?: OrganizationRole
  }
  'organizations.options': {
    search?: string
    role?: OrganizationRole
  }
  'organizations.mergeOptions': {
    search?: string
    organizationId?: number
  }
  'organizations.roleRemove': Omit<CatalogWireInput<'organizations.roleRemove'>, 'planId' | 'planDigest'> & {
    planId?: string
    planDigest?: string
  }
  'organizations.delete': {
    organizationId: number
    planId?: string
    planDigest?: string
  }
  'directors.delete': {
    directorId: number
    planId?: string
    planDigest?: string
  }
  'series.delete': {
    seriesId: number
    planId?: string
    planDigest?: string
  }
  'classificationImages.set': {
    entity: ClassificationEntityRef
    image: CatalogWireInput<'classificationImages.set'>['image'] | ClassificationImageInput | null
  }
  'playlists.create': CatalogWireInput<'playlists.create'> & PlaylistCreateInput
  'playlists.get': CatalogWireInput<'playlists.get'> & {
    sortBy?: PlaylistVideoSortBy
    sortDir?: SortDir
  }
  'playlists.metadata': CatalogWireInput<'playlists.metadata'> & {
    sortBy?: PlaylistVideoSortBy
    sortDir?: SortDir
  }
  'playlists.update': CatalogWireInput<'playlists.update'> & PlaylistUpdateInput
  'libraries.update': CatalogWireInput<'libraries.update'> | UpdateMediaLibraryInput
  'libraries.updateConfig': CatalogWireInput<'libraries.updateConfig'> & {
    expectedRevision?: number
  }
  'libraries.addRoot': CatalogWireInput<'libraries.addRoot'> | AddMediaLibraryRootInput
  'libraries.updateRoot': CatalogWireInput<'libraries.updateRoot'> | UpdateMediaLibraryRootInput
  'libraries.removeRoot': CatalogWireInput<'libraries.removeRoot'> | RemoveMediaLibraryRootInput
  'libraries.cancelRootRemoval': CatalogWireInput<'libraries.cancelRootRemoval'> & {
    expectedRevision?: number
  }
  'libraries.archive': CatalogWireInput<'libraries.archive'> & {
    expectedRevision?: number
  }
  'libraries.restore': CatalogWireInput<'libraries.restore'> & {
    expectedRevision?: number
  }
  'libraries.delete': CatalogWireInput<'libraries.delete'> | DeleteMediaLibraryInput
  'pendingScan.get': CatalogWireInput<'pendingScan.get'> & {
    libraryId?: number
  }
  'pendingResourceIdentity.get': CatalogWireInput<'pendingResourceIdentity.get'> & {
    libraryId?: number
  }
  'pendingScan.resolve': CatalogWireInput<'pendingScan.resolve'> & {
    libraryId?: number
    expectedRevision?: number
  }
  'pendingResourceIdentity.resolve': CatalogWireInput<'pendingResourceIdentity.resolve'> & {
    libraryId?: number
    expectedRevision?: number
  }
  'pendingVideoScrapes.replace': Omit<CatalogWireInput<'pendingVideoScrapes.replace'>, 'selectedFields' | 'applicableFields' | 'sources'> & {
    selectedFields: VideoScrapeField[]
    applicableFields: VideoScrapeField[]
    sources: Array<Omit<CatalogWireInput<'pendingVideoScrapes.replace'>['sources'][number], 'selectedFields'> & {
      selectedFields: VideoScrapeField[]
    }>
  }
  'uploads.create': UploadCreateInput
}
export type CatalogOperationInput<K extends ManageOperationId> = K extends keyof CatalogDesktopInputs
  ? CatalogDesktopInputs[K]
  : CatalogWireInput<K>
