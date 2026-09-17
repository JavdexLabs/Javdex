import { IPC } from '@shared/ipc-channels'
import type { CatalogBackend } from '../application/catalogBackend'
import { ipcMutation } from '../application/mutationContext'
import { structuredError } from '@shared/protocol/errors'
import type { ActressAvatarAutoCropTarget } from '@shared/actressAvatarCropTypes'
import type { ActressFaceScanManifestItem } from '@shared/actressTypes'
import { registerActressHandler } from './actressContractAdapter'
import { collectCatalogActressAvatarCropTargets } from '../application/catalogActressAvatarCropSnapshot'

export interface ActressHandlerDesktopQueries {
  listAvatarCropTargets(): ActressAvatarAutoCropTarget[]
  countAvatarCropTargets(): number
  listFaceScanManifest(): ActressFaceScanManifestItem[]
  getTestTarget(id: number): string | null
}

export function registerActressHandlers(
  backend: CatalogBackend,
  desktopQueries?: ActressHandlerDesktopQueries
): void {
  registerActressHandler(IPC.ACTRESS_PROFILE, (id) =>
    backend.actresses.profile({ actressId: id })
  )
  registerActressHandler(IPC.ACTRESS_GALLERY_PAGE, (id, query) =>
    backend.actresses.galleryPage({ actressId: id, ...query })
  )
  registerActressHandler(IPC.ACTRESS_METADATA, (id) =>
    backend.actresses.metadata({ actressId: id })
  )
  registerActressHandler(IPC.ACTRESS_VIDEO_PAGE, (id, query) =>
    backend.actresses.videoPage({ actressId: id, ...query })
  )
  registerActressHandler(IPC.ACTRESS_TEST_TARGET_PAGE, (query) =>
    backend.actresses.testTargetPage(query ?? {})
  )
  registerActressHandler(IPC.ACTRESS_TEST_TARGET_GET, (id) => {
    if (!desktopQueries) {
      throw structuredError('UNSUPPORTED_CAPABILITY', '当前模式不能读取插件测试演员。')
    }
    return desktopQueries.getTestTarget(id)
  })
  registerActressHandler(IPC.ACTRESS_AVATAR_CROP_TARGETS, () => {
    if (desktopQueries) return desktopQueries.listAvatarCropTargets()
    return collectCatalogActressAvatarCropTargets(backend)
  })
  registerActressHandler(IPC.ACTRESS_AVATAR_CROP_COUNT, async () => {
    if (desktopQueries) return desktopQueries.countAvatarCropTargets()
    return (await collectCatalogActressAvatarCropTargets(backend)).length
  })
  registerActressHandler(IPC.ACTRESS_MERGE_CANDIDATES, (query) =>
    backend.actresses.mergeCandidates(query)
  )
  registerActressHandler(IPC.ACTRESS_PICKER_GET, (id) =>
    backend.actresses.pickerGet({ actressId: id })
  )
  registerActressHandler(IPC.ACTRESS_PICKER_PAGE, (query) =>
    backend.actresses.pickerPage(query ?? {})
  )
  registerActressHandler(IPC.ACTRESS_LIST, (...args) =>
    backend.actresses.list({
      search: args[0],
      gender: args[1],
      sortBy: args[2],
      sortDir: args[3]
    })
  )
  registerActressHandler(IPC.ACTRESS_LIST_PAGE, (query) =>
    backend.actresses.listPage(query ?? {})
  )
  registerActressHandler(IPC.ACTRESS_FACE_SCAN_MANIFEST, () => {
    if (!desktopQueries) {
      throw structuredError('UNSUPPORTED_CAPABILITY', '当前模式不能读取人脸扫描清单。')
    }
    return desktopQueries.listFaceScanManifest()
  })
  registerActressHandler(IPC.ACTRESS_GET, (id) =>
    backend.actresses.get({ actressId: id })
  )
  registerActressHandler(IPC.ACTRESS_AVATAR_SOURCE_INFO, (id) =>
    backend.actresses.avatarSourceInfo({ actressId: id })
  )
  registerActressHandler(IPC.ACTRESS_EDIT, (id, input) =>
    backend.actresses.edit({ actressId: id, fields: input }, ipcMutation())
  )
  registerActressHandler(IPC.ACTRESS_DELETE_PREVIEW, (ids) =>
    backend.actresses.deletePreview({ ids })
  )
  registerActressHandler(IPC.ACTRESS_DELETE, (request) =>
    backend.actresses.deleteBatch(request, ipcMutation())
  )
  registerActressHandler(IPC.ACTRESS_DELETE_BATCH, (request) =>
    backend.actresses.deleteBatch(request, ipcMutation())
  )
  registerActressHandler(IPC.ACTRESS_CLEAR_META, (id) =>
    backend.actresses.clearMeta({ actressId: id }, ipcMutation())
  )
  registerActressHandler(IPC.ACTRESS_MERGE, (input) =>
    backend.actresses.merge(input, ipcMutation())
  )
  registerActressHandler(IPC.ACTRESS_MARK_SCRAPE_SUCCESS, (id) =>
    backend.actresses.markScrapeSuccess({ actressId: id }, ipcMutation())
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_LIST, () =>
    backend.actresses.conflictList({})
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_QUEUE_PAGE, (query) =>
    backend.actresses.conflictQueuePage(query)
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_GET, (normalizedName) =>
    backend.actresses.conflictGet({ normalizedName })
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_COUNT, () =>
    backend.actresses.conflictCount({})
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_SUMMARY, () =>
    backend.actresses.conflictSummary({})
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_INSPECT_NAME, (input) =>
    backend.actresses.inspectName(input)
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_DISCARD, (input) =>
    backend.actresses.discardConflict(input, ipcMutation())
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_VALIDATE_ILLEGAL, (input) =>
    backend.actresses.validateIllegal(input, ipcMutation())
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_RESOLVE, (input) =>
    backend.actresses.resolveConflict(input, ipcMutation())
  )
  registerActressHandler(IPC.ACTRESS_GALLERY_IMPORT, async (id, input) => {
    const result = await backend.actresses.importGallery({ actressId: id, ...input }, ipcMutation())
    if (!('id' in result)) throw structuredError('INVALID_INPUT', '本机图库导入未返回媒体资源')
    return result
  })
  registerActressHandler(IPC.ACTRESS_GALLERY_DELETE, (id, assetId) =>
    backend.actresses.deleteGallery({ actressId: id, assetId }, ipcMutation())
  )
  registerActressHandler(IPC.ACTRESS_POSTER_SET, (id, posterPath) =>
    backend.actresses.setPoster(
      {
        actressId: id,
        image: posterPath == null ? { kind: 'clear' } : { kind: 'asset', assetId: 1 },
        posterPath
      },
      ipcMutation()
    )
  )
}
