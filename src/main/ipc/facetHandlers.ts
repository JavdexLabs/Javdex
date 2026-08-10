import { IPC } from '@shared/ipc-channels'
import type { FacetItem, FacetType } from '@shared/libraryTypes'
import { deleteFacetEntry, listFacet } from '../db/facetRepo'
import { listTags, listManualTags } from '../db/tagRepo'
import { appCommandAdapter } from './appContractAdapter'
import { classificationQueryService } from '../services/classificationQueryService'
import { classificationMaintenanceService } from '../services/classificationMaintenanceService'

interface OrganizationHandlerDependencies {
  queryService: typeof classificationQueryService
  maintenanceService: typeof classificationMaintenanceService
}

export function registerOrganizationHandlers(
  adapter: typeof appCommandAdapter = appCommandAdapter,
  dependencies: OrganizationHandlerDependencies = {
    queryService: classificationQueryService,
    maintenanceService: classificationMaintenanceService
  }
): void {
  adapter.register(IPC.ORGANIZATION_LIST, (query) =>
    dependencies.queryService.listOrganizations(query)
  )
  adapter.register(IPC.ORGANIZATION_GET, (id, role) =>
    dependencies.queryService.getOrganization(id, role)
  )
  adapter.register(IPC.ORGANIZATION_OPTIONS, (search) =>
    dependencies.queryService.listOrganizationOptions(search)
  )
  adapter.register(IPC.ORGANIZATION_CREATE, (input) =>
    dependencies.maintenanceService.createOrganization(input)
  )
  adapter.register(IPC.ORGANIZATION_UPDATE, (id, input) =>
    dependencies.maintenanceService.updateOrganization(id, input)
  )
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
  adapter.register(IPC.SERIES_LIST, (query) => dependencies.queryService.listSeries(query))
  adapter.register(IPC.SERIES_GET, (id) => dependencies.queryService.getSeries(id))
  adapter.register(IPC.SERIES_OPTIONS, (search) => dependencies.queryService.listSeriesOptions(search))
  adapter.register(IPC.SERIES_CREATE, (input) => dependencies.maintenanceService.createSeries(input))
  adapter.register(IPC.SERIES_UPDATE, (id, input) =>
    dependencies.maintenanceService.updateSeries(id, input)
  )
}

export function registerFacetHandlers(): void {
  appCommandAdapter.register(
    IPC.TAG_LIST,
    (): Array<{ id: number; name: string; video_count: number }> => listTags()
  )

  appCommandAdapter.register(
    IPC.TAG_LIST_MANUAL,
    (): Array<{ id: number; name: string; video_count: number }> => listManualTags()
  )

  appCommandAdapter.register(IPC.FACET_LIST, (type): FacetItem[] => listFacet(type))

  appCommandAdapter.register(IPC.FACET_DELETE, (type, value): boolean => {
    deleteFacetEntry(type, value)
    return true
  })

  registerOrganizationHandlers()
}
