import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IpcChannel } from '@shared/ipc-channels'
import { IPC } from '@shared/ipc-channels'
import type { ClassificationQueryService } from '../services/classificationQueryService'
import type { ClassificationMaintenanceService } from '../services/classificationMaintenanceService'
import type { ClassificationImageService } from '../services/classificationImageService'
import type { DirectorMergeService } from '../services/directorMergeService'
import type { SeriesMergeService } from '../services/seriesMergeService'
import type { OrganizationMergeService } from '../services/organizationMergeService'
import type { ClassificationDeletionService } from '../services/classificationDeletionService'
import { appCommandAdapter } from './appContractAdapter'
import { registerClassificationHandlers } from './facetHandlers'

describe('classification IPC contract', () => {
  it('registers every command and forwards typed arguments to the public services', async () => {
    const calls: unknown[] = []
    const queryService: ClassificationQueryService = {
      listImageCandidates(entity) {
        calls.push(['image-candidates', entity])
        return []
      },
      listOrganizations(query) {
        calls.push(['list', query])
        return []
      },
      getOrganization(id, role) {
        calls.push(['get', id, role])
        return null
      },
      listOrganizationOptions(search) {
        calls.push(['options', search])
        return []
      },
      listOrganizationMergeOptions(search) {
        calls.push(['merge-options', search])
        return []
      },
      listDirectors(query) {
        calls.push(['director-list', query])
        return []
      },
      getDirector(id) {
        calls.push(['director-get', id])
        return null
      },
      listDirectorOptions(search) {
        calls.push(['director-options', search])
        return []
      },
      listSeries(query) {
        calls.push(['series-list', query])
        return []
      },
      getSeries(id) {
        calls.push(['series-get', id])
        return null
      },
      listSeriesOptions(search) {
        calls.push(['series-options', search])
        return []
      }
    }
    const maintenanceService: ClassificationMaintenanceService = {
      createOrganization(input) {
        calls.push(['create', input])
        return 17
      },
      updateOrganization(id, input) {
        calls.push(['update', id, input])
        return true
      },
      assignVideoOrganization() {
        throw new Error('not used by organization IPC')
      },
      createDirector(input) {
        calls.push(['director-create', input])
        return 23
      },
      updateDirector(id, input) {
        calls.push(['director-update', id, input])
        return true
      },
      assignVideoDirector() {
        throw new Error('not used by director IPC')
      },
      createSeries(input) {
        calls.push(['series-create', input])
        return 31
      },
      updateSeries(id, input) {
        calls.push(['series-update', id, input])
        return true
      },
      assignVideoSeries() {
        throw new Error('not used by series IPC')
      }
    }
    const imageService: ClassificationImageService = {
      async setImage(entity, input) {
        calls.push(['image-set', entity, input])
        return { imagePath: 'covers/classification.jpg', cleanupFailures: [] }
      }
    }
    const directorMergeService: DirectorMergeService = {
      merge(input) {
        calls.push(['director-merge', input])
        return {
          targetId: input.targetId,
          sourceId: input.sourceId,
          transferredVideoCount: 2,
          imagePath: 'avatars/director.jpg',
          cleanupFailures: []
        }
      }
    }
    const organizationMergeService: OrganizationMergeService = {
      merge(input) {
        calls.push(['organization-merge', input])
        return {
          targetId: input.targetId,
          sourceId: input.sourceId,
          transferredMakerVideoCount: 3,
          transferredPublisherVideoCount: 4,
          transferredChildCount: 2,
          transferredSeriesCount: 1,
          imagePath: 'covers/organization.jpg',
          cleanupFailures: []
        }
      }
    }
    const seriesMergeService: SeriesMergeService = {
      merge(input) {
        calls.push(['series-merge', input])
        return {
          targetId: input.targetId,
          sourceId: input.sourceId,
          transferredVideoCount: 3,
          transferredChildCount: 2,
          imagePath: 'covers/series.jpg',
          cleanupFailures: []
        }
      }
    }
    const deletionService: ClassificationDeletionService = {
      previewDirector(id) {
        calls.push(['director-delete-preview', id])
        return { id, videoCount: 2 }
      },
      deleteDirector(id) {
        calls.push(['director-delete', id])
        return { id, unlinkedVideoCount: 3, cleanupFailures: [] }
      },
      previewSeries(id) {
        calls.push(['series-delete-preview', id])
        return { id, videoCount: 4, directChildCount: 1 }
      },
      deleteSeries(id) {
        calls.push(['series-delete', id])
        return { id, unlinkedVideoCount: 5, detachedChildCount: 2, cleanupFailures: [] }
      }
    }
    const handlers = new Map<IpcChannel, (...args: unknown[]) => unknown>()
    const adapter = {
      register(channel: IpcChannel, handler: (...args: unknown[]) => unknown) {
        handlers.set(channel, handler)
      }
    } as typeof appCommandAdapter

    registerClassificationHandlers(adapter, {
      queryService,
      maintenanceService,
      imageService,
      deletionService,
      organizationMergeService,
      directorMergeService,
      seriesMergeService
    })

    const listQuery = { role: 'maker' as const, search: 'studio' }
    const createInput = { role: 'publisher' as const, mainName: 'Studio' }
    const updateInput = { mainName: 'Renamed' }
    assert.deepEqual(handlers.get(IPC.ORGANIZATION_LIST)?.(listQuery), [])
    assert.equal(handlers.get(IPC.ORGANIZATION_GET)?.(12, 'publisher'), null)
    assert.deepEqual(handlers.get(IPC.ORGANIZATION_OPTIONS)?.('alias'), [])
    assert.deepEqual(handlers.get(IPC.ORGANIZATION_MERGE_OPTIONS)?.('source'), [])
    assert.equal(handlers.get(IPC.ORGANIZATION_CREATE)?.(createInput), 17)
    assert.equal(handlers.get(IPC.ORGANIZATION_UPDATE)?.(12, updateInput), true)
    const organizationMergeInput = { targetId: 12, sourceId: 13 }
    assert.deepEqual(handlers.get(IPC.ORGANIZATION_MERGE)?.(organizationMergeInput), {
      targetId: 12,
      sourceId: 13,
      transferredMakerVideoCount: 3,
      transferredPublisherVideoCount: 4,
      transferredChildCount: 2,
      transferredSeriesCount: 1,
      imagePath: 'covers/organization.jpg',
      cleanupFailures: []
    })
    const directorQuery = { search: 'lee' }
    const directorInput = { mainName: 'Alex Lee' }
    assert.deepEqual(handlers.get(IPC.DIRECTOR_LIST)?.(directorQuery), [])
    assert.equal(handlers.get(IPC.DIRECTOR_GET)?.(23), null)
    assert.deepEqual(handlers.get(IPC.DIRECTOR_OPTIONS)?.('alex'), [])
    assert.equal(handlers.get(IPC.DIRECTOR_CREATE)?.(directorInput), 23)
    assert.equal(handlers.get(IPC.DIRECTOR_UPDATE)?.(23, directorInput), true)
    const directorMergeInput = { targetId: 23, sourceId: 24 }
    assert.deepEqual(handlers.get(IPC.DIRECTOR_MERGE)?.(directorMergeInput), {
      targetId: 23,
      sourceId: 24,
      transferredVideoCount: 2,
      imagePath: 'avatars/director.jpg',
      cleanupFailures: []
    })
    assert.deepEqual(handlers.get(IPC.DIRECTOR_DELETE_PREVIEW)?.(23), { id: 23, videoCount: 2 })
    assert.deepEqual(handlers.get(IPC.DIRECTOR_DELETE)?.(23), {
      id: 23,
      unlinkedVideoCount: 3,
      cleanupFailures: []
    })
    const seriesQuery = { search: 'collection' }
    const seriesInput = { mainName: 'Collection' }
    assert.deepEqual(handlers.get(IPC.SERIES_LIST)?.(seriesQuery), [])
    assert.equal(handlers.get(IPC.SERIES_GET)?.(31), null)
    assert.deepEqual(handlers.get(IPC.SERIES_OPTIONS)?.('collection'), [])
    assert.equal(handlers.get(IPC.SERIES_CREATE)?.(seriesInput), 31)
    assert.equal(handlers.get(IPC.SERIES_UPDATE)?.(31, seriesInput), true)
    const seriesMergeInput = { targetId: 31, sourceId: 32 }
    assert.deepEqual(handlers.get(IPC.SERIES_MERGE)?.(seriesMergeInput), {
      targetId: 31,
      sourceId: 32,
      transferredVideoCount: 3,
      transferredChildCount: 2,
      imagePath: 'covers/series.jpg',
      cleanupFailures: []
    })
    assert.deepEqual(handlers.get(IPC.SERIES_DELETE_PREVIEW)?.(31), {
      id: 31,
      videoCount: 4,
      directChildCount: 1
    })
    assert.deepEqual(handlers.get(IPC.SERIES_DELETE)?.(31), {
      id: 31,
      unlinkedVideoCount: 5,
      detachedChildCount: 2,
      cleanupFailures: []
    })
    const imageEntity = { kind: 'series' as const, id: 31 }
    const imageInput = { source: 'video-cover' as const, videoId: 8 }
    assert.deepEqual(handlers.get(IPC.CLASSIFICATION_IMAGE_CANDIDATES)?.(imageEntity), [])
    assert.deepEqual(
      await handlers.get(IPC.CLASSIFICATION_IMAGE_SET)?.(imageEntity, imageInput),
      { imagePath: 'covers/classification.jpg', cleanupFailures: [] }
    )
    assert.deepEqual(calls, [
      ['list', listQuery],
      ['get', 12, 'publisher'],
      ['options', 'alias'],
      ['merge-options', 'source'],
      ['create', createInput],
      ['update', 12, updateInput],
      ['organization-merge', organizationMergeInput],
      ['director-list', directorQuery],
      ['director-get', 23],
      ['director-options', 'alex'],
      ['director-create', directorInput],
      ['director-update', 23, directorInput],
      ['director-merge', directorMergeInput],
      ['director-delete-preview', 23],
      ['director-delete', 23],
      ['series-list', seriesQuery],
      ['series-get', 31],
      ['series-options', 'collection'],
      ['series-create', seriesInput],
      ['series-update', 31, seriesInput],
      ['series-merge', seriesMergeInput],
      ['series-delete-preview', 31],
      ['series-delete', 31],
      ['image-candidates', imageEntity],
      ['image-set', imageEntity, imageInput]
    ])
  })
})
