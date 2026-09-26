import { IPC } from '@shared/ipc-channels'
import type { CatalogBackend } from '../application/catalogBackend'
import { ipcActressMutation, ipcMutation } from '../application/mutationContext'
import { structuredError } from '@shared/protocol/errors'
import type { ActressAvatarAutoCropTarget } from '@shared/actressAvatarCropTypes'
import type { ActressFaceScanManifestItem } from '@shared/actressTypes'
import { registerActressHandler } from './actressContractAdapter'
import { collectCatalogActressAvatarCropTargets } from '../application/catalogActressAvatarCropSnapshot'
import { uploadCatalogImageBase64, uploadCatalogImageSource } from '../application/remoteCatalogImage'

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
  registerActressHandler(IPC.ACTRESS_EDIT, async (id, input, expectedVersions) => {
    if (backend.mode !== 'remote') {
      return backend.actresses.edit({ actressId: id, fields: input }, await ipcActressMutation(backend, id, expectedVersions))
    }
    const {
      avatar,
      avatarSourcePath: _avatarSourcePath,
      avatarImageBase64: _avatarImageBase64,
      clearAvatar: _clearAvatar,
      ...fields
    } = input
    const remoteAvatar = avatar
      ? await uploadCatalogImageBase64(backend, 'actressAvatar', avatar.displayImageBase64)
      : _clearAvatar
        ? { kind: 'clear' as const }
        : undefined
    return backend.actresses.edit({
      actressId: id,
      fields: { ...fields, ...(remoteAvatar ? { avatar: remoteAvatar } : {}) }
    }, await ipcActressMutation(backend, id, expectedVersions))
  })
  registerActressHandler(IPC.ACTRESS_DELETE_PREVIEW, (ids) =>
    backend.actresses.deletePreview({ ids })
  )
  registerActressHandler(IPC.ACTRESS_DELETE, async (request) => {
    // The legacy IPC request is a one-or-many shape.  Keep the batch path for
    // compatibility, but provide the aggregate version when the server can
    // enforce it for the single-actress operation.
    if (request.ids.length === 1) {
      const mutation = await ipcActressMutation(backend, request.ids[0])
      return backend.actresses.delete({ actressId: request.ids[0], mode: request.mode }, mutation)
    }
    return backend.actresses.deleteBatch(request, ipcMutation())
  })
  registerActressHandler(IPC.ACTRESS_DELETE_BATCH, (request) =>
    backend.actresses.deleteBatch(request, ipcMutation())
  )
  registerActressHandler(IPC.ACTRESS_CLEAR_META, async (id, expectedVersions) =>
    backend.actresses.clearMeta({ actressId: id }, await ipcActressMutation(backend, id, expectedVersions))
  )
  registerActressHandler(IPC.ACTRESS_MERGE, async (input, expectedVersions) =>
    backend.actresses.merge(input, await ipcActressMutation(backend, input.keepId, expectedVersions))
  )
  registerActressHandler(IPC.ACTRESS_MARK_SCRAPE_SUCCESS, async (id, expectedVersions) =>
    backend.actresses.markScrapeSuccess({ actressId: id }, await ipcActressMutation(backend, id, expectedVersions))
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
    const normalized = backend.mode === 'remote'
      ? {
          actressId: id,
          images: [await uploadCatalogImageSource(backend, 'actressGallery', input)]
        }
      : { actressId: id, ...input }
    const result = await backend.actresses.importGallery(
      normalized as never,
      await ipcActressMutation(backend, id)
    )
    if (backend.mode === 'local' && !('id' in result)) {
      throw structuredError('INVALID_INPUT', '本机图库导入未返回媒体资源')
    }
    return result
  })
  registerActressHandler(IPC.ACTRESS_GALLERY_DELETE, async (id, assetId, expectedVersions) =>
    backend.actresses.deleteGallery(
      { actressId: id, assetId },
      await ipcActressMutation(backend, id, expectedVersions)
    )
  )
  registerActressHandler(IPC.ACTRESS_POSTER_SET, async (id, posterPath, assetId, expectedVersions) => {
    if (backend.mode === 'remote' && posterPath !== null && !assetId) {
      throw structuredError('INVALID_INPUT', '写真缺少媒体资源 ID，请刷新后重试')
    }
    return backend.actresses.setPoster(
      {
        actressId: id,
        image: posterPath == null ? { kind: 'clear' } : { kind: 'asset', assetId: assetId! },
        ...(backend.mode === 'remote' ? { slot: 'galleryPoster' as const } : {}),
        ...(backend.mode === 'local' ? { posterPath } : {})
      },
      await ipcActressMutation(backend, id, expectedVersions)
    )
  })
}
