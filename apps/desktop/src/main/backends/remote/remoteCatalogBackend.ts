import { randomUUID } from 'node:crypto'
import { ManageHttpClient } from '@http/manageClient'
import { digestToken, generateSecret } from '@library/catalog/catalogSecrets'
import { structuredError, isStructuredError, type StructuredError } from '@shared/protocol/errors'
import type { HandshakeResult } from '@shared/protocol/handshake'
import type { CatalogIdentity } from '@shared/protocol/identity'
import type {
  DesktopSession,
  DesktopSessionState,
  DesktopWriterClaimRequest,
  DesktopWriterClaimResult
} from '@shared/desktop/session'
import type { CatalogBackend } from '../../application/catalogBackend'
import type { CatalogQueryContext, MutationContext } from '../../application/catalogBackend'
import type { DesktopCredentialStore } from '../../application/desktopPorts'
import { createRemoteSessionCapabilities } from '../../application/desktopCapabilities'

export interface RemoteCatalogBackendOptions {
  baseUrl: string
  appVersion: string
  credentials: DesktopCredentialStore
  generation?: number
  timeoutMs?: number
  workStore?: { putVerification(operationId: string, catalogId: string): void }
}

const QUERY_KEYS = [
  'homeLoad',
  'homeSearch',
  'listVideos',
  'getVideo',
  'listVideoYears',
  'getResource',
  'listTags',
  'listManualTags',
  'tagLabels',
  'tagFilterOptions',
  'tagManualOptions',
  'overviewStats'
] as const

const VIDEO_KEYS = [
  'edit',
  'clearMeta',
  'markScrapeSuccess',
  'setRating',
  'setPoster',
  'importSamples',
  'deleteSample',
  'addManualTag',
  'addExistingManualTag',
  'removeManualTag',
  'correctImport',
  'importResource',
  'updateResource',
  'updateLocalResourceLabel',
  'setPrimaryResource',
  'removeResource',
  'previewRemoveFromLibrary',
  'removeFromLibrary',
  'previewMoveResource',
  'moveResource',
  'previewDeleteGlobal',
  'deleteGlobal',
  'merge',
  'splitResource',
  'applyScrapeCandidate'
] as const

const ACTRESS_KEYS = [
  'list',
  'listPage',
  'pickerPage',
  'pickerGet',
  'get',
  'profile',
  'metadata',
  'videoPage',
  'galleryPage',
  'avatarSourceInfo',
  'mergeCandidates',
  'edit',
  'delete',
  'deleteBatch',
  'deletePreview',
  'clearMeta',
  'importGallery',
  'deleteGallery',
  'setPoster',
  'merge',
  'markScrapeSuccess',
  'applyCrop',
  'applyScrapeCandidate',
  'testTargetPage',
  'conflictList',
  'conflictQueuePage',
  'conflictGet',
  'conflictCount',
  'conflictSummary',
  'inspectName',
  'discardConflict',
  'validateIllegal',
  'resolveConflict'
] as const

const CLASSIFICATION_KEYS = [
  'listOrganizations',
  'pageOrganizations',
  'getOrganization',
  'createOrganization',
  'updateOrganization',
  'mergeOrganizations',
  'deleteOrganization',
  'organizationOptions',
  'organizationMergeOptions',
  'organizationRoleRemovePreview',
  'organizationRoleRemove',
  'organizationDeletePreview',
  'listDirectors',
  'pageDirectors',
  'getDirector',
  'createDirector',
  'updateDirector',
  'mergeDirectors',
  'deleteDirector',
  'directorOptions',
  'directorDeletePreview',
  'listSeries',
  'pageSeries',
  'getSeries',
  'createSeries',
  'updateSeries',
  'mergeSeries',
  'deleteSeries',
  'seriesOptions',
  'seriesDeletePreview',
  'imagePage',
  'imageCandidates',
  'setImage'
] as const

const PLAYLIST_KEYS = [
  'list',
  'listPage',
  'get',
  'getPage',
  'metadata',
  'videoPage',
  'listForVideo',
  'create',
  'update',
  'delete',
  'addVideo',
  'removeVideo',
  'applyImport'
] as const

const LIBRARY_KEYS = [
  'list',
  'get',
  'create',
  'update',
  'updateConfig',
  'addRoot',
  'updateRoot',
  'removeRoot',
  'cancelRootRemoval',
  'archive',
  'restore',
  'deletePreview',
  'delete',
  'runScan',
  'cancelScan',
  'latestScan',
  'renameFile',
  'importManual',
  'resolvePendingScan',
  'resolveResourceIdentity'
] as const

const NFO_KEYS = [
  'getOptions',
  'updatePreferences',
  'plan',
  'discardPlan',
  'start',
  'terminate',
  'state'
] as const

const BROWSER_KEYS = [
  'status',
  'setEnabled',
  'pairOpen',
  'pairInspect',
  'pairDecide',
  'deviceRemove',
  'deviceRename',
  'deviceReset',
  'revokeSessions'
] as const

const TASK_KEYS = [
  'get',
  'list',
  'cancel',
  'getOperation',
  'createTargetList',
  'pageTargetList'
] as const

const ASSET_KEYS = ['createUpload', 'inspectUpload', 'putUpload', 'grantPlayback'] as const
const MIGRATION_KEYS = ['preview', 'start', 'status', 'allowEnable', 'enable', 'abandon'] as const

function rejectSlice<T extends object>(
  keys: readonly (keyof T)[],
  run: (key: keyof T) => Promise<never>
): T {
  return Object.fromEntries(keys.map((key) => [key, () => run(key)])) as T
}

/**
 * HTTP CatalogBackend. Does not import or open library.db.
 */
export function createRemoteCatalogBackend(options: RemoteCatalogBackendOptions): CatalogBackend {
  const client = new ManageHttpClient({
    baseUrl: options.baseUrl,
    appVersion: options.appVersion,
    timeoutMs: options.timeoutMs
  })
  let generation = options.generation ?? 1
  const identity: CatalogIdentity = { mode: 'remote', catalogId: '' }
  let handshake: HandshakeResult | null = null
  let secret: string | null = null
  let sessionState: DesktopSessionState = 'disconnected'
  let sessionMessage: string | null = '尚未连接到远程资料库'
  const inFlight = new Set<AbortController>()

  const session = (): DesktopSession => ({
    state: sessionState,
    mode: 'remote',
    catalogId: identity.catalogId || null,
    serverId: identity.serverId ?? null,
    generation,
    writerEpoch: handshake?.writerEpoch ?? null,
    frozen: handshake?.ready === 'frozen' || sessionState === 'frozen',
    appVersion: handshake?.appVersion ?? options.appVersion,
    schemaVersion: handshake?.schemaVersion ?? null,
    message: sessionMessage
  })

  const trackSignal = (external?: AbortSignal): { signal: AbortSignal; done: () => void } => {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    external?.addEventListener('abort', onAbort)
    inFlight.add(controller)
    return {
      signal: controller.signal,
      done: () => {
        inFlight.delete(controller)
        external?.removeEventListener('abort', onAbort)
      }
    }
  }

  const abortInFlight = (): void => {
    for (const controller of [...inFlight]) controller.abort()
    inFlight.clear()
  }

  const markUnavailable = (error: StructuredError): never => {
    if (error.code === 'VERSION_MISMATCH') {
      sessionState = 'versionMismatch'
    } else if (error.code === 'AUTH_REQUIRED' || error.code === 'WRITER_REVOKED') {
      sessionState = 'authInvalid'
    } else if (error.code === 'CATALOG_FROZEN') {
      sessionState = 'frozen'
    } else if (error.code === 'RECOVERY_REQUIRED') {
      sessionState = 'recoveryRequired'
    } else {
      sessionState = 'disconnected'
    }
    sessionMessage = error.message
    throw error
  }

  const handshakeOnly = async (signal?: AbortSignal): Promise<HandshakeResult> => {
    const hello = (await client.post(
      'handshake.get',
      { input: {} },
      { sendAppVersion: false, signal }
    )) as HandshakeResult
    identity.catalogId = hello.identity.catalogId
    identity.serverId = hello.identity.serverId
    handshake = hello
    if (hello.appVersion !== options.appVersion) {
      throw structuredError('VERSION_MISMATCH', '桌面与服务器应用版本不一致')
    }
    return hello
  }

  const ensureConnected = async (signal?: AbortSignal): Promise<HandshakeResult> => {
    if (handshake && secret && (sessionState === 'available' || sessionState === 'frozen')) {
      return handshake
    }
    try {
      const hello = await handshakeOnly(signal)
      secret = await options.credentials.readWriterSecret(hello.identity.catalogId)
      if (!secret) {
        sessionState = hello.writerEpoch > 0 ? 'recoveryRequired' : 'disconnected'
        sessionMessage =
          hello.writerEpoch > 0 ? '缺少写入凭据，需要重新领取' : '远程资料库尚未认主'
        throw structuredError(
          hello.writerEpoch > 0 ? 'RECOVERY_REQUIRED' : 'CONNECTION_UNAVAILABLE',
          sessionMessage
        )
      }
      if (hello.ready === 'frozen') {
        sessionState = 'frozen'
        sessionMessage = '资料库已冻结'
        return hello
      }
      sessionState = 'available'
      sessionMessage = null
      return hello
    } catch (error) {
      throw markUnavailable(
        isStructuredError(error) ? error : structuredError('CONNECTION_UNAVAILABLE', '无法连接远程资料库')
      )
    }
  }

  const query = async (operation: string, input: unknown, signal?: AbortSignal): Promise<unknown> => {
    const tracked = trackSignal(signal)
    try {
      const hello = await ensureConnected(tracked.signal)
      if (!secret) throw structuredError('RECOVERY_REQUIRED', '缺少写入凭据')
      return await client.post(
        operation,
        {
          serverId: hello.identity.serverId,
          catalogId: hello.identity.catalogId,
          writerEpoch: hello.writerEpoch,
          input
        },
        { bearer: secret, signal: tracked.signal }
      )
    } finally {
      tracked.done()
    }
  }

  const mutate = async (
    operation: string,
    input: unknown,
    ctx: { operationId: string; expectedVersions: unknown; signal?: AbortSignal }
  ): Promise<unknown> => {
    const tracked = trackSignal(ctx.signal)
    try {
      const hello = await ensureConnected(tracked.signal)
      if (!secret) throw structuredError('RECOVERY_REQUIRED', '缺少写入凭据')
      if (hello.writerEpoch < 1) {
        throw structuredError('AUTH_REQUIRED', '远程资料库尚未认主')
      }
      if (hello.identity.catalogId) {
        options.workStore?.putVerification(ctx.operationId, hello.identity.catalogId)
      }
      return await client.post(
        operation,
        {
          operationId: ctx.operationId,
          serverId: hello.identity.serverId,
          catalogId: hello.identity.catalogId,
          writerEpoch: hello.writerEpoch,
          expectedVersions: ctx.expectedVersions,
          input
        },
        { bearer: secret, signal: tracked.signal }
      )
    } finally {
      tracked.done()
    }
  }

  const unsupported = async (label: string): Promise<never> => {
    await ensureConnected()
    throw structuredError('UNSUPPORTED_CAPABILITY', `远程尚未实现 ${label}`)
  }

  const q = (operation: string) => (input: unknown, ctx?: CatalogQueryContext) =>
    query(operation, input ?? {}, ctx?.signal)
  const m = (operation: string) => (input: unknown, ctx: MutationContext) => mutate(operation, input, ctx)
  const mOk = (operation: string) => async (input: unknown, ctx: MutationContext) => {
    const result = (await mutate(operation, input, ctx)) as { ok?: boolean }
    return result.ok ?? result
  }
  const mId = (operation: string) => async (input: unknown, ctx: MutationContext) => {
    const result = (await mutate(operation, input, ctx)) as { id?: number }
    return result.id ?? result
  }
  const withPlan = (input: Record<string, unknown>, ctx: MutationContext): Record<string, unknown> => {
    const planDigest =
      typeof input.planDigest === 'string'
        ? input.planDigest
        : typeof input.expectedRevision === 'string'
          ? input.expectedRevision
          : typeof input.expectedImpactRevision === 'string'
            ? input.expectedImpactRevision
            : undefined
    const {
      expectedRevision: _expectedRevision,
      expectedImpactRevision: _expectedImpactRevision,
      operationId: _operationId,
      ...rest
    } = input
    return {
      ...rest,
      planId: typeof input.planId === 'string' ? input.planId : ctx.operationId,
      ...(planDigest ? { planDigest } : {})
    }
  }
  const mPlan = (operation: string) => (input: unknown, ctx: MutationContext) =>
    mutate(operation, withPlan((input ?? {}) as Record<string, unknown>, ctx), ctx)
  const qPending = (qRev: number | undefined, ctx: MutationContext): MutationContext => ({
    ...ctx,
    expectedVersions: {
      ...ctx.expectedVersions,
      ...(qRev != null ? { Q: ctx.expectedVersions.Q ?? { generation: 1, revision: qRev } } : {})
    }
  })

  const reconnect = async (): Promise<DesktopSession> => {
    abortInFlight()
    generation += 1
    handshake = null
    secret = null
    sessionState = 'disconnected'
    sessionMessage = '正在重新连接'
    try {
      await ensureConnected()
    } catch {
      // Session state already records the failure; callers read the snapshot.
    }
    return session()
  }

  const claimWriter = async (input: DesktopWriterClaimRequest): Promise<DesktopWriterClaimResult> => {
    const tracked = trackSignal()
    try {
      const hello = await handshakeOnly(tracked.signal)
      const nextSecret = generateSecret()
      const result = (await client.post(
        'writer.claim',
        {
          serverId: hello.identity.serverId,
          catalogId: hello.identity.catalogId,
          input: {
            kind: input.kind,
            oneTimeToken: input.oneTimeToken,
            candidate: { claimId: randomUUID(), secretDigest: digestToken(nextSecret) }
          }
        },
        { signal: tracked.signal }
      )) as DesktopWriterClaimResult
      if (result.status === 'consumed' && result.bound) {
        await options.credentials.writeWriterSecret(hello.identity.catalogId, nextSecret)
      }
      await reconnect()
      return result
    } catch (error) {
      throw markUnavailable(
        isStructuredError(error) ? error : structuredError('CONNECTION_UNAVAILABLE', '无法领取写入凭据')
      )
    } finally {
      tracked.done()
    }
  }

  return {
    mode: 'remote',
    identity,
    get generation() {
      return generation
    },
    capabilities: () => createRemoteSessionCapabilities(sessionState, handshake?.ready === 'frozen'),
    session,
    reconnect,
    claimWriter,
    queries: {
      ...rejectSlice(QUERY_KEYS, (key) => unsupported(`queries.${String(key)}`)),
      homeLoad: q('home.load'),
      homeSearch: q('home.search'),
      listVideos: q('videos.list'),
      getVideo: q('videos.get'),
      listVideoYears: q('videos.years'),
      getResource: q('videos.getResource'),
      listTags: q('tags.list'),
      listManualTags: q('tags.listManual'),
      tagLabels: q('tags.labels'),
      tagFilterOptions: q('tags.filterOptions'),
      tagManualOptions: q('tags.manualOptions'),
      overviewStats: (input, ctx) => query('catalog.overviewStats', input ?? {}, ctx?.signal)
    },
    videos: {
      ...rejectSlice(VIDEO_KEYS, (key) => unsupported(`videos.${String(key)}`)),
      edit: mOk('videos.edit'),
      setRating: mOk('videos.setRating'),
      clearMeta: mOk('videos.clearMeta'),
      markScrapeSuccess: mOk('videos.markScrapeSuccess'),
      deleteSample: mOk('videos.deleteSample'),
      addManualTag: mOk('videos.addManualTag'),
      addExistingManualTag: mOk('videos.addExistingManualTag'),
      removeManualTag: mOk('videos.removeManualTag'),
      correctImport: m('videos.correctImport'),
      importResource: m('videos.importResource'),
      updateResource: m('videos.updateResource'),
      updateLocalResourceLabel: m('videos.updateLocalResourceLabel'),
      setPrimaryResource: mOk('videos.setPrimaryResource'),
      removeResource: m('videos.removeResource'),
      previewRemoveFromLibrary: q('videos.previewRemoveFromLibrary'),
      removeFromLibrary: mPlan('videos.removeFromLibrary'),
      previewMoveResource: q('videos.previewMoveResource'),
      moveResource: mPlan('videos.moveResource'),
      previewDeleteGlobal: q('videos.previewDeleteGlobal'),
      deleteGlobal: mPlan('videos.deleteGlobal'),
      merge: m('videos.merge'),
      splitResource: m('videos.splitResource'),
      setPoster: m('videos.setPoster'),
      importSamples: m('videos.importSamples')
    },
    actresses: {
      ...rejectSlice(ACTRESS_KEYS, (key) => unsupported(`actresses.${String(key)}`)),
      list: q('actresses.list'),
      listPage: q('actresses.listPage'),
      pickerPage: q('actresses.pickerPage'),
      pickerGet: q('actresses.pickerGet'),
      get: q('actresses.get'),
      profile: q('actresses.profile'),
      metadata: q('actresses.metadata'),
      videoPage: q('actresses.videoPage'),
      galleryPage: q('actresses.galleryPage'),
      avatarSourceInfo: q('actresses.avatarSourceInfo'),
      mergeCandidates: q('actresses.mergeCandidates'),
      testTargetPage: q('actresses.testTargetPage'),
      deletePreview: q('actresses.deletePreview'),
      edit: mOk('actresses.edit'),
      delete: m('actresses.delete'),
      deleteBatch: m('actresses.deleteBatch'),
      clearMeta: mOk('actresses.clearMeta'),
      merge: mOk('actresses.merge'),
      markScrapeSuccess: mOk('actresses.markScrapeSuccess'),
      deleteGallery: mOk('actresses.deleteGallery'),
      setPoster: m('actresses.setPoster'),
      importGallery: m('actresses.importGallery'),
      applyCrop: m('actresses.applyCrop'),
      conflictList: q('actressConflicts.list'),
      conflictQueuePage: q('actressConflicts.queuePage'),
      conflictGet: q('actressConflicts.get'),
      conflictCount: q('actressConflicts.count'),
      conflictSummary: q('actressConflicts.summary'),
      inspectName: (input, ctx) =>
        query('actressConflicts.inspectName', { name: (input as { name: string }).name }, ctx?.signal),
      discardConflict: (input, ctx) =>
        mutate(
          'actressConflicts.discard',
          { pendingId: (input as { pendingId: number }).pendingId },
          qPending((input as { expectedRevision?: number }).expectedRevision, ctx)
        ),
      validateIllegal: (input, ctx) =>
        mutate(
          'actressConflicts.validateIllegal',
          {
            pendingId:
              (input as { pendingId?: number }).pendingId ??
              (input as { snapshot?: { candidates?: Array<{ pendingId: number }> } }).snapshot
                ?.candidates?.[0]?.pendingId,
            replacements: input
          },
          ctx
        ),
      resolveConflict: (input, ctx) => {
        const body = input as { pendingId?: number; snapshot?: { candidates?: Array<{ pendingId: number }> } }
        return mutate(
          'actressConflicts.resolve',
          {
            pendingId: body.pendingId ?? body.snapshot?.candidates?.[0]?.pendingId,
            choices: input
          },
          ctx
        )
      }
    },
    classifications: {
      ...rejectSlice(CLASSIFICATION_KEYS, (key) => unsupported(`classifications.${String(key)}`)),
      listOrganizations: q('organizations.list'),
      pageOrganizations: q('organizations.page'),
      getOrganization: q('organizations.get'),
      organizationOptions: q('organizations.options'),
      organizationMergeOptions: q('organizations.mergeOptions'),
      createOrganization: mId('organizations.create'),
      updateOrganization: mOk('organizations.update'),
      mergeOrganizations: m('organizations.merge'),
      organizationRoleRemovePreview: q('organizations.roleRemovePreview'),
      organizationRoleRemove: mPlan('organizations.roleRemove'),
      organizationDeletePreview: q('organizations.deletePreview'),
      deleteOrganization: mPlan('organizations.delete'),
      listDirectors: q('directors.list'),
      pageDirectors: q('directors.page'),
      getDirector: q('directors.get'),
      directorOptions: q('directors.options'),
      createDirector: mId('directors.create'),
      updateDirector: mOk('directors.update'),
      mergeDirectors: m('directors.merge'),
      directorDeletePreview: q('directors.deletePreview'),
      deleteDirector: mPlan('directors.delete'),
      listSeries: q('series.list'),
      pageSeries: q('series.page'),
      getSeries: q('series.get'),
      seriesOptions: q('series.options'),
      createSeries: mId('series.create'),
      updateSeries: mOk('series.update'),
      mergeSeries: m('series.merge'),
      seriesDeletePreview: q('series.deletePreview'),
      deleteSeries: mPlan('series.delete'),
      imagePage: q('classificationImages.page'),
      imageCandidates: q('classificationImages.candidates'),
      setImage: m('classificationImages.set')
    },
    playlists: {
      ...rejectSlice(PLAYLIST_KEYS, (key) => unsupported(`playlists.${String(key)}`)),
      list: q('playlists.list'),
      listPage: q('playlists.listPage'),
      get: q('playlists.get'),
      getPage: q('playlists.getPage'),
      metadata: q('playlists.metadata'),
      videoPage: q('playlists.videoPage'),
      listForVideo: q('playlists.listForVideo'),
      create: m('playlists.create'),
      update: m('playlists.update'),
      delete: mOk('playlists.delete'),
      addVideo: mOk('playlists.addVideo'),
      removeVideo: mOk('playlists.removeVideo')
    },
    libraries: {
      ...rejectSlice(LIBRARY_KEYS, (key) => unsupported(`libraries.${String(key)}`)),
      list: (input, ctx) => query('libraries.list', input ?? {}, ctx?.signal),
      get: q('libraries.get'),
      create: m('libraries.create'),
      update: m('libraries.update'),
      updateConfig: m('libraries.updateConfig'),
      archive: m('libraries.archive'),
      restore: m('libraries.restore'),
      deletePreview: q('libraries.deletePreview'),
      delete: (input, ctx) => {
        const local = (input ?? {}) as {
          libraryId: number
          expectedRevision?: number
          expectedImpactRevision?: string
          planId?: string
          planDigest?: string
        }
        return mutate(
          'libraries.delete',
          withPlan(
            {
              libraryId: local.libraryId,
              planId: local.planId,
              planDigest: local.planDigest ?? local.expectedImpactRevision
            },
            ctx
          ),
          {
            ...ctx,
            expectedVersions: {
              ...ctx.expectedVersions,
              ...(local.expectedRevision != null
                ? {
                    L: ctx.expectedVersions.L ?? { generation: 1, revision: local.expectedRevision }
                  }
                : {})
            }
          }
        )
      },
      resolvePendingScan: (input, ctx) => {
        const local = input as {
          groupId: number
          assignments: unknown
          primaryResourceIds?: Record<string, number>
          expectedRevision?: number
        }
        return mutate(
          'pendingScan.resolve',
          {
            groupId: local.groupId,
            assignments: local.assignments,
            ...(local.primaryResourceIds ? { primaryResourceIds: local.primaryResourceIds } : {})
          },
          qPending(local.expectedRevision, ctx)
        )
      },
      resolveResourceIdentity: (input, ctx) => {
        const local = input as {
          identityId: number
          choice: 'filename' | 'nfo' | 'discard'
          expectedRevision?: number
        }
        return mutate(
          'pendingResourceIdentity.resolve',
          { identityId: local.identityId, choice: local.choice },
          qPending(local.expectedRevision, ctx)
        )
      }
    },
    nfo: rejectSlice(NFO_KEYS, (key) => unsupported(`nfo.${String(key)}`)),
    browser: {
      ...rejectSlice(BROWSER_KEYS, (key) => unsupported(`browser.${String(key)}`)),
      status: (input, ctx) => query('browser.status', input ?? {}, ctx?.signal),
      setEnabled: m('browser.setEnabled'),
      pairOpen: m('browser.pairOpen'),
      pairInspect: q('browser.pairInspect'),
      pairDecide: m('browser.pairDecide'),
      deviceRemove: m('browser.deviceRemove'),
      deviceRename: m('browser.deviceRename'),
      deviceReset: m('browser.deviceReset'),
      revokeSessions: m('browser.revokeSessions')
    },
    tasks: {
      ...rejectSlice(TASK_KEYS, (key) => unsupported(`tasks.${String(key)}`)),
      async getOperation(input, ctx) {
        return query('operations.get', input, ctx?.signal)
      }
    },
    assets: {
      ...rejectSlice(ASSET_KEYS, (key) => unsupported(`assets.${String(key)}`)),
      async createUpload(input, ctx) {
        const result = (await mutate('uploads.create', input, ctx)) as { uploadId: string }
        return result
      },
      async inspectUpload(input, ctx) {
        return query('uploads.inspect', input, ctx?.signal)
      },
      async putUpload(input, ctx) {
        const tracked = trackSignal(ctx?.signal)
        try {
          await ensureConnected(tracked.signal)
          if (!secret) throw structuredError('RECOVERY_REQUIRED', '缺少写入凭据')
          return await client.putUpload(input.uploadId, input.body, input.contentType, {
            bearer: secret,
            signal: tracked.signal
          })
        } finally {
          tracked.done()
        }
      }
    },
    migration: rejectSlice(MIGRATION_KEYS, (key) => unsupported(`migration.${String(key)}`)),
    async dispose(): Promise<void> {
      abortInFlight()
      handshake = null
      secret = null
      sessionState = 'disconnected'
      sessionMessage = '已断开远程资料库'
    }
  }
}
