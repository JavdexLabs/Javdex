import { IPC } from '@shared/ipc-channels'
import type {
  ClassificationEntityRef,
  ClassificationImageCandidate,
  ClassificationListPage,
  ClassificationPageQuery
} from '@shared/classificationTypes'
import type { CatalogBackend } from '../application/catalogBackend'
import { ipcMutation } from '../application/mutationContext'
import { appCommandAdapter } from './appContractAdapter'
import type { ClassificationQueryService } from '../services/classificationQueryService'
import type { ClassificationMaintenanceService } from '../services/classificationMaintenanceService'
import type { ClassificationImageService } from '../services/classificationImageService'
import type { DirectorMergeService } from '../services/directorMergeService'
import type { SeriesMergeService } from '../services/seriesMergeService'
import type { OrganizationMergeService } from '../services/organizationMergeService'
import type { ClassificationDeletionService } from '../services/classificationDeletionService'
import type { OrganizationDeletionService } from '../services/organizationDeletionService'

interface ClassificationHandlerDependencies {
  readService: {
    readImageCandidates(
      entity: ClassificationEntityRef,
      query?: ClassificationPageQuery,
      signal?: AbortSignal
    ): Promise<ClassificationListPage<ClassificationImageCandidate>>
  }
  queryService: ClassificationQueryService
  maintenanceService: ClassificationMaintenanceService
  imageService: ClassificationImageService
  organizationMergeService: OrganizationMergeService
  organizationDeletionService: OrganizationDeletionService
  deletionService: ClassificationDeletionService
  directorMergeService: DirectorMergeService
  seriesMergeService: SeriesMergeService
}

export function registerClassificationHandlers(
  adapter: typeof appCommandAdapter,
  dependencies: ClassificationHandlerDependencies
): void {
  adapter.register(IPC.ORGANIZATION_PAGE, (query) => dependencies.queryService.listOrganizationsPage(query))
  adapter.register(IPC.SERIES_PAGE, (query) => dependencies.queryService.listSeriesPage(query))
  adapter.register(IPC.ORGANIZATION_LIST, (query) =>
    dependencies.queryService.listOrganizations(query)
  )
  adapter.register(IPC.ORGANIZATION_GET, (id, role) =>
    dependencies.queryService.getOrganization(id, role)
  )
  adapter.register(IPC.ORGANIZATION_OPTIONS, (search) =>
    dependencies.queryService.listOrganizationOptions(search)
  )
  adapter.register(IPC.ORGANIZATION_MERGE_OPTIONS, (search) =>
    dependencies.queryService.listOrganizationMergeOptions(search)
  )
  adapter.register(IPC.ORGANIZATION_CREATE, (input) =>
    dependencies.maintenanceService.createOrganization(input)
  )
  adapter.register(IPC.ORGANIZATION_UPDATE, (id, input) =>
    dependencies.maintenanceService.updateOrganization(id, input)
  )
  adapter.register(IPC.ORGANIZATION_MERGE, (input) =>
    dependencies.organizationMergeService.merge(input)
  )
  adapter.register(IPC.ORGANIZATION_ROLE_REMOVE_PREVIEW, (id, role) =>
    dependencies.organizationDeletionService.previewRoleRemoval(id, role)
  )
  adapter.register(IPC.ORGANIZATION_ROLE_REMOVE, (id, role) =>
    dependencies.organizationDeletionService.removeRole(id, role)
  )
  adapter.register(IPC.ORGANIZATION_DELETE_PREVIEW, (id) =>
    dependencies.organizationDeletionService.previewOrganization(id)
  )
  adapter.register(IPC.ORGANIZATION_DELETE, (id) =>
    dependencies.organizationDeletionService.deleteOrganization(id)
  )
  adapter.register(IPC.DIRECTOR_PAGE, (query) => dependencies.queryService.listDirectorsPage(query))
  adapter.register(IPC.DIRECTOR_LIST, (query) => dependencies.queryService.listDirectors(query))
  adapter.register(IPC.DIRECTOR_GET, (id) => dependencies.queryService.getDirector(id))
  adapter.register(IPC.DIRECTOR_OPTIONS, (search) =>
    dependencies.queryService.listDirectorOptions(search)
  )
  adapter.register(IPC.DIRECTOR_CREATE, (input) =>
    dependencies.maintenanceService.createDirector(input)
  )
  adapter.register(IPC.DIRECTOR_UPDATE, (id, input) =>
    dependencies.maintenanceService.updateDirector(id, input)
  )
  adapter.register(IPC.DIRECTOR_MERGE, (input) =>
    dependencies.directorMergeService.merge(input)
  )
  adapter.register(IPC.DIRECTOR_DELETE_PREVIEW, (id) =>
    dependencies.deletionService.previewDirector(id)
  )
  adapter.register(IPC.DIRECTOR_DELETE, (id) => dependencies.deletionService.deleteDirector(id))
  adapter.register(IPC.SERIES_LIST, (query) => dependencies.queryService.listSeries(query))
  adapter.register(IPC.SERIES_GET, (id) => dependencies.queryService.getSeries(id))
  adapter.register(IPC.SERIES_OPTIONS, (search) => dependencies.queryService.listSeriesOptions(search))
  adapter.register(IPC.SERIES_CREATE, (input) => dependencies.maintenanceService.createSeries(input))
  adapter.register(IPC.SERIES_UPDATE, (id, input) =>
    dependencies.maintenanceService.updateSeries(id, input)
  )
  adapter.register(IPC.SERIES_MERGE, (input) => dependencies.seriesMergeService.merge(input))
  adapter.register(IPC.SERIES_DELETE_PREVIEW, (id) =>
    dependencies.deletionService.previewSeries(id)
  )
  adapter.register(IPC.SERIES_DELETE, (id) => dependencies.deletionService.deleteSeries(id))
  adapter.register(IPC.CLASSIFICATION_IMAGE_PAGE, (entity, query) => dependencies.readService.readImageCandidates(entity, query))
  adapter.register(IPC.CLASSIFICATION_IMAGE_CANDIDATES, (entity) =>
    dependencies.queryService.listImageCandidates(entity)
  )
  adapter.register(IPC.CLASSIFICATION_IMAGE_SET, (entity, input) =>
    dependencies.imageService.setImage(entity, input)
  )
}

export function registerFacetHandlers(
  backend: CatalogBackend,
  adapter: typeof appCommandAdapter = appCommandAdapter
): void {
  adapter.register(IPC.TAG_LABELS, (ids) => backend.queries.tagLabels({ ids }))
  adapter.register(IPC.TAG_FILTER_OPTIONS, (query) => backend.queries.tagFilterOptions(query))
  adapter.register(IPC.TAG_MANUAL_OPTIONS, (query) => backend.queries.tagManualOptions(query))
  adapter.register(IPC.TAG_LIST, () => backend.queries.listTags({}))
  adapter.register(IPC.TAG_LIST_MANUAL, () => backend.queries.listManualTags({}))

  adapter.register(IPC.ORGANIZATION_PAGE, (query) => backend.classifications.pageOrganizations(query))
  adapter.register(IPC.SERIES_PAGE, (query) => backend.classifications.pageSeries(query))
  adapter.register(IPC.ORGANIZATION_LIST, (query) => backend.classifications.listOrganizations(query))
  adapter.register(IPC.ORGANIZATION_GET, (id, role) =>
    backend.classifications.getOrganization({ organizationId: id, role } as never)
  )
  adapter.register(IPC.ORGANIZATION_OPTIONS, (search) =>
    backend.classifications.organizationOptions({ search })
  )
  adapter.register(IPC.ORGANIZATION_MERGE_OPTIONS, (search) =>
    backend.classifications.organizationMergeOptions({ search })
  )
  adapter.register(IPC.ORGANIZATION_CREATE, (input) =>
    backend.classifications.createOrganization(input, ipcMutation())
  )
  adapter.register(IPC.ORGANIZATION_UPDATE, (id, input) =>
    backend.classifications.updateOrganization(
      { organizationId: id, ...input },
      ipcMutation()
    )
  )
  adapter.register(IPC.ORGANIZATION_MERGE, (input) =>
    backend.classifications.mergeOrganizations(input, ipcMutation())
  )
  adapter.register(IPC.ORGANIZATION_ROLE_REMOVE_PREVIEW, (id, role) =>
    backend.classifications.organizationRoleRemovePreview({ organizationId: id, role })
  )
  adapter.register(IPC.ORGANIZATION_ROLE_REMOVE, (id, role) =>
    backend.classifications.organizationRoleRemove({ organizationId: id, role } as never, ipcMutation())
  )
  adapter.register(IPC.ORGANIZATION_DELETE_PREVIEW, (id) =>
    backend.classifications.organizationDeletePreview({ organizationId: id })
  )
  adapter.register(IPC.ORGANIZATION_DELETE, (id) =>
    backend.classifications.deleteOrganization({ organizationId: id } as never, ipcMutation())
  )
  adapter.register(IPC.DIRECTOR_PAGE, (query) => backend.classifications.pageDirectors(query))
  adapter.register(IPC.DIRECTOR_LIST, (query) => backend.classifications.listDirectors(query ?? {}))
  adapter.register(IPC.DIRECTOR_GET, (id) => backend.classifications.getDirector({ directorId: id }))
  adapter.register(IPC.DIRECTOR_OPTIONS, (search) =>
    backend.classifications.directorOptions({ search })
  )
  adapter.register(IPC.DIRECTOR_CREATE, (input) =>
    backend.classifications.createDirector(input, ipcMutation())
  )
  adapter.register(IPC.DIRECTOR_UPDATE, (id, input) =>
    backend.classifications.updateDirector({ directorId: id, ...input }, ipcMutation())
  )
  adapter.register(IPC.DIRECTOR_MERGE, (input) =>
    backend.classifications.mergeDirectors(input, ipcMutation())
  )
  adapter.register(IPC.DIRECTOR_DELETE_PREVIEW, (id) =>
    backend.classifications.directorDeletePreview({ directorId: id })
  )
  adapter.register(IPC.DIRECTOR_DELETE, (id) =>
    backend.classifications.deleteDirector({ directorId: id } as never, ipcMutation())
  )
  adapter.register(IPC.SERIES_LIST, (query) => backend.classifications.listSeries(query ?? {}))
  adapter.register(IPC.SERIES_GET, (id) => backend.classifications.getSeries({ seriesId: id }))
  adapter.register(IPC.SERIES_OPTIONS, (search) =>
    backend.classifications.seriesOptions({ search })
  )
  adapter.register(IPC.SERIES_CREATE, (input) =>
    backend.classifications.createSeries(input, ipcMutation())
  )
  adapter.register(IPC.SERIES_UPDATE, (id, input) =>
    backend.classifications.updateSeries({ seriesId: id, ...input }, ipcMutation())
  )
  adapter.register(IPC.SERIES_MERGE, (input) =>
    backend.classifications.mergeSeries(input, ipcMutation())
  )
  adapter.register(IPC.SERIES_DELETE_PREVIEW, (id) =>
    backend.classifications.seriesDeletePreview({ seriesId: id })
  )
  adapter.register(IPC.SERIES_DELETE, (id) =>
    backend.classifications.deleteSeries({ seriesId: id } as never, ipcMutation())
  )
  adapter.register(IPC.CLASSIFICATION_IMAGE_PAGE, (entity, query) =>
    backend.classifications.imagePage({ entity, ...query })
  )
  adapter.register(IPC.CLASSIFICATION_IMAGE_CANDIDATES, (entity) =>
    backend.classifications.imageCandidates({ entity })
  )
  adapter.register(IPC.CLASSIFICATION_IMAGE_SET, (entity, input) =>
    backend.classifications.setImage({ entity, image: input as never }, ipcMutation())
  )
}
