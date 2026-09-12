import { IPC } from '@shared/ipc-channels'
import { appCommandAdapter } from './appContractAdapter'
import { tagQueryService } from '../services/tagQueryService'
import { catalogReadService } from '../services/catalogReadService'
import { classificationQueryService } from '../services/classificationQueryService'
import { classificationMaintenanceService } from '../services/classificationMaintenanceService'
import { classificationImageService } from '../services/classificationImageService'
import { directorMergeService } from '../services/directorMergeService'
import { seriesMergeService } from '../services/seriesMergeService'
import { organizationMergeService } from '../services/organizationMergeService'
import { classificationDeletionService } from '../services/classificationDeletionService'
import { organizationDeletionService } from '../services/organizationDeletionService'

interface ClassificationHandlerDependencies {
  readService: Pick<typeof catalogReadService, 'readImageCandidates'>
  queryService: typeof classificationQueryService
  maintenanceService: typeof classificationMaintenanceService
  imageService: typeof classificationImageService
  organizationMergeService: typeof organizationMergeService
  organizationDeletionService: typeof organizationDeletionService
  deletionService: typeof classificationDeletionService
  directorMergeService: typeof directorMergeService
  seriesMergeService: typeof seriesMergeService
}

export function registerClassificationHandlers(
  adapter: typeof appCommandAdapter = appCommandAdapter,
  dependencies: ClassificationHandlerDependencies = {
    readService: catalogReadService,
    queryService: classificationQueryService,
    maintenanceService: classificationMaintenanceService,
    imageService: classificationImageService,
    organizationMergeService,
    organizationDeletionService,
    deletionService: classificationDeletionService,
    directorMergeService,
    seriesMergeService
  }
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

export function registerFacetHandlers(): void {
  appCommandAdapter.register(IPC.TAG_LABELS, (ids) => tagQueryService.labels(ids))
  appCommandAdapter.register(IPC.TAG_FILTER_OPTIONS, (query) => catalogReadService.read(query))
  appCommandAdapter.register(IPC.TAG_MANUAL_OPTIONS, (query) => tagQueryService.manualOptions(query))
  appCommandAdapter.register(
    IPC.TAG_LIST,
    (): Array<{ id: number; name: string; video_count: number }> => tagQueryService.list()
  )

  appCommandAdapter.register(
    IPC.TAG_LIST_MANUAL,
    (): Array<{ id: number; name: string; video_count: number }> => tagQueryService.listManual()
  )

  registerClassificationHandlers()
}
