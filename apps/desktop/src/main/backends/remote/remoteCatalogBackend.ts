import { catalogRemoteResult } from './catalogRemoteResults'
import { parseManageInput } from '@shared/manage/parse'
import type { CatalogOperationInput, CatalogWireInput } from '../../application/catalogOperationInputs'
import type { CatalogOperationResults } from '../../application/catalogOperationResults'
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
import {
  openRemoteImageDiskCache,
  type RemoteImageDiskCache
} from '../../services/remoteImageDiskCache'

export interface RemoteCatalogBackendOptions {
  baseUrl: string
  appVersion: string
  credentials: DesktopCredentialStore
  generation?: number
  timeoutMs?: number
  workStore?: { putVerification(operationId: string, catalogId: string): void }
  migrationSecret?: string | null
  userDataPath?: string
}

function requirePendingId(id: number | undefined): number {
  if (id == null) throw structuredError('INVALID_INPUT', '缺少待确认结果 ID')
  return id
}

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
  let imageCache: RemoteImageDiskCache | null = null
  let imageCacheCatalogId: string | null = null

  const cacheFor = (catalogId: string): RemoteImageDiskCache | null => {
    if (!options.userDataPath || !catalogId) return null
    if (imageCache && imageCacheCatalogId === catalogId) return imageCache
    imageCache = openRemoteImageDiskCache({
      userDataPath: options.userDataPath,
      catalogId
    })
    imageCacheCatalogId = catalogId
    return imageCache
  }

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
    const timeout = AbortSignal.timeout(client.timeoutMs)
    const onAbort = (): void => controller.abort()
    external?.addEventListener('abort', onAbort)
    timeout.addEventListener('abort', onAbort)
    inFlight.add(controller)
    return {
      signal: controller.signal,
      done: () => {
        inFlight.delete(controller)
        external?.removeEventListener('abort', onAbort)
        timeout.removeEventListener('abort', onAbort)
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

  const wire = <K extends keyof CatalogOperationResults>(operation: K, input: unknown): CatalogWireInput<K> => {
    const parsed = parseManageInput(operation, input)
    if (!parsed.success) throw structuredError('INVALID_INPUT', `Invalid input for ${operation}`)
    return parsed.data as CatalogWireInput<K>
  }

  const query = async <K extends keyof CatalogOperationResults>(operation: K, input: CatalogWireInput<K>, signal?: AbortSignal): Promise<CatalogOperationResults[K]> => {
    const tracked = trackSignal(signal)
    try {
      const hello = await ensureConnected(tracked.signal)
      if (!secret) throw structuredError('RECOVERY_REQUIRED', '缺少写入凭据')
      return catalogRemoteResult(operation, await client.post(
        operation,
        {
          serverId: hello.identity.serverId,
          catalogId: hello.identity.catalogId,
          writerEpoch: hello.writerEpoch,
          input
        },
        { bearer: secret, signal: tracked.signal }
      ))
    } finally {
      tracked.done()
    }
  }

  const mutate = async <K extends keyof CatalogOperationResults>(
    operation: K,
    input: CatalogWireInput<K>,
    ctx: MutationContext
  ): Promise<CatalogOperationResults[K]> => {
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
      return catalogRemoteResult(operation, await client.post(
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
      ))
    } finally {
      tracked.done()
    }
  }

  const migrate = async <K extends keyof CatalogOperationResults>(operation: K, input: CatalogWireInput<K>, signal?: AbortSignal): Promise<CatalogOperationResults[K]> => {
    const tracked = trackSignal(signal)
    try {
      if (!options.migrationSecret) {
        throw structuredError('AUTH_REQUIRED', '缺少迁移凭据')
      }
      return catalogRemoteResult(operation, await client.post(operation, { input }, { bearer: options.migrationSecret, signal: tracked.signal }))
    } finally {
      tracked.done()
    }
  }


  const q = <K extends keyof CatalogOperationResults>(operation: K) =>
    (input: CatalogOperationInput<K>, ctx?: CatalogQueryContext) =>
      query(operation, wire(operation, input), ctx?.signal)
  const m = <K extends keyof CatalogOperationResults>(operation: K) =>
    (input: CatalogOperationInput<K>, ctx: MutationContext) =>
      mutate(operation, wire(operation, input), ctx)
  const libraryMutation = (
    ctx: MutationContext,
    expectedRevision: number | undefined,
    field: 'L' | 'C',
    rootOperation = false
  ): MutationContext => ({
    ...ctx,
    expectedVersions: {
      ...ctx.expectedVersions,
      ...(expectedRevision == null ? {} : {
        [field]: ctx.expectedVersions[field] ?? { generation: 1, revision: expectedRevision }
      }),
      ...(rootOperation ? { G: ctx.expectedVersions.G ?? { generation: 1, revision: 1 } } : {})
    }
  })
  const libraryRevisionCommand = <K extends 'libraries.updateConfig' | 'libraries.archive' | 'libraries.restore' | 'libraries.cancelRootRemoval'>(operation: K) =>
    (input: CatalogOperationInput<K>, ctx: MutationContext) => {
      const { expectedRevision, ...rest } = input as CatalogOperationInput<K> & { expectedRevision?: number }
      return mutate(operation, wire(operation, rest), libraryMutation(ctx, expectedRevision,
        operation === 'libraries.updateConfig' ? 'C' : 'L', operation === 'libraries.cancelRootRemoval'))
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
  const mPlan = <K extends keyof CatalogOperationResults>(operation: K) => (input: CatalogOperationInput<K>, ctx: MutationContext) =>
    mutate(operation, wire(operation, withPlan(input as Record<string, unknown>, ctx)), ctx)
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
      homeLoad: q('home.load'),
      homeSearch: q('home.search'),
      listVideos: q('videos.list'),
      getVideo: q('videos.get'),
      listVideoYears: q('videos.years'),
      resolveScrapeFields: q('scrape.fields'),
      listVideoSources: q('videos.sources'),
      getResource: q('videos.getResource'),
      listTags: q('tags.list'),
      listManualTags: q('tags.listManual'),
      tagLabels: q('tags.labels'),
      tagFilterOptions: q('tags.filterOptions'),
      tagManualOptions: q('tags.manualOptions'),
      overviewStats: (input, ctx) => query('catalog.overviewStats', input ?? {}, ctx?.signal)
    },
    videos: {
      edit: m('videos.edit'),
      setRating: m('videos.setRating'),
      clearMeta: m('videos.clearMeta'),
      markScrapeSuccess: m('videos.markScrapeSuccess'),
      markScrapeFailed: m('videos.markScrapeFailed'),
      deleteSample: m('videos.deleteSample'),
      addManualTag: m('videos.addManualTag'),
      addExistingManualTag: m('videos.addExistingManualTag'),
      removeManualTag: m('videos.removeManualTag'),
      correctImport: m('videos.correctImport'),
      importResource: m('videos.importResource'),
      updateResource: m('videos.updateResource'),
      updateLocalResourceLabel: m('videos.updateLocalResourceLabel'),
      setPrimaryResource: m('videos.setPrimaryResource'),
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
      importSamples: m('videos.importSamples'),
      applyScrapeCandidate: m('videos.applyScrapeCandidate')
    },
    actresses: {
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
      edit: m('actresses.edit'),
      delete: m('actresses.delete'),
      deleteBatch: m('actresses.deleteBatch'),
      clearMeta: m('actresses.clearMeta'),
      merge: m('actresses.merge'),
      markScrapeSuccess: m('actresses.markScrapeSuccess'),
      markScrapeFailed: m('actresses.markScrapeFailed'),
      deleteGallery: m('actresses.deleteGallery'),
      setPoster: m('actresses.setPoster'),
      importGallery: m('actresses.importGallery'),
      applyCrop: m('actresses.applyCrop'),
      applyScrapeCandidate: m('actresses.applyScrapeCandidate'),
      submitConflict: m('actressConflicts.submit'),
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
            pendingId: requirePendingId(
              (input as { pendingId?: number }).pendingId ??
              (input as { snapshot?: { candidates?: Array<{ pendingId: number }> } }).snapshot
                ?.candidates?.[0]?.pendingId),
            replacements: input
          },
          ctx
        ),
      resolveConflict: (input, ctx) => {
        const body = input as { pendingId?: number; snapshot?: { candidates?: Array<{ pendingId: number }> } }
        return mutate(
          'actressConflicts.resolve',
          {
            pendingId: requirePendingId(body.pendingId ?? body.snapshot?.candidates?.[0]?.pendingId),
            choices: input
          },
          ctx
        )
      }
    },
    classifications: {
      listOrganizations: q('organizations.list'),
      pageOrganizations: q('organizations.page'),
      getOrganization: q('organizations.get'),
      organizationOptions: q('organizations.options'),
      organizationMergeOptions: q('organizations.mergeOptions'),
      createOrganization: m('organizations.create'),
      updateOrganization: m('organizations.update'),
      mergeOrganizations: m('organizations.merge'),
      organizationRoleRemovePreview: q('organizations.roleRemovePreview'),
      organizationRoleRemove: mPlan('organizations.roleRemove'),
      organizationDeletePreview: q('organizations.deletePreview'),
      deleteOrganization: mPlan('organizations.delete'),
      listDirectors: q('directors.list'),
      pageDirectors: q('directors.page'),
      getDirector: q('directors.get'),
      directorOptions: q('directors.options'),
      createDirector: m('directors.create'),
      updateDirector: m('directors.update'),
      mergeDirectors: m('directors.merge'),
      directorDeletePreview: q('directors.deletePreview'),
      deleteDirector: mPlan('directors.delete'),
      listSeries: q('series.list'),
      pageSeries: q('series.page'),
      getSeries: q('series.get'),
      seriesOptions: q('series.options'),
      createSeries: m('series.create'),
      updateSeries: m('series.update'),
      mergeSeries: m('series.merge'),
      seriesDeletePreview: q('series.deletePreview'),
      deleteSeries: mPlan('series.delete'),
      imagePage: q('classificationImages.page'),
      imageCandidates: q('classificationImages.candidates'),
      setImage: m('classificationImages.set')
    },
    playlists: {
      list: q('playlists.list'),
      listPage: q('playlists.listPage'),
      get: q('playlists.get'),
      getPage: q('playlists.getPage'),
      metadata: q('playlists.metadata'),
      videoPage: q('playlists.videoPage'),
      listForVideo: q('playlists.listForVideo'),
      create: m('playlists.create'),
      update: m('playlists.update'),
      delete: m('playlists.delete'),
      addVideo: m('playlists.addVideo'),
      removeVideo: m('playlists.removeVideo'),
      applyImport: m('playlists.applyImport')
    },
    libraries: {
      list: (input, ctx) => query('libraries.list', input ?? {}, ctx?.signal),
      get: q('libraries.get'),
      create: m('libraries.create'),
      update: (input, ctx) => {
        const { expectedRevision, ...rest } = input as CatalogOperationInput<'libraries.update'> & { expectedRevision?: number }
        const payload = 'patch' in rest ? { libraryId: rest.libraryId, ...rest.patch } : rest
        return mutate('libraries.update', wire('libraries.update', payload), libraryMutation(ctx, expectedRevision, 'L'))
      },
      updateConfig: libraryRevisionCommand('libraries.updateConfig'),
      archive: libraryRevisionCommand('libraries.archive'),
      restore: libraryRevisionCommand('libraries.restore'),
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
          wire('libraries.delete', withPlan(
            {
              libraryId: local.libraryId,
              planId: local.planId,
              planDigest: local.planDigest ?? local.expectedImpactRevision
            },
            ctx
          )),
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
      addRoot: (input, ctx) => {
        const local = input as {
          libraryId: number
          expectedRevision?: number
          root: { mountSelectionId?: string; path?: string; position?: number; state?: 'active' | 'disabled' | 'pending_removal' }
        }
        if (local.root.path) {
          throw structuredError('INVALID_INPUT', '远程添加根目录不能发送主机路径')
        }
        if (!local.root.mountSelectionId) {
          throw structuredError('INVALID_INPUT', '远程添加根目录必须使用 mountSelectionId')
        }
        return mutate(
          'libraries.addRoot',
          {
            libraryId: local.libraryId,
            root: {
              mountSelectionId: local.root.mountSelectionId,
              ...(local.root.position != null ? { position: local.root.position } : {}),
              ...(local.root.state != null ? { state: local.root.state } : {})
            }
          },
          libraryMutation(ctx, local.expectedRevision, 'L', true)
        )
      },
      updateRoot: (input, ctx) => {
        const local = input as {
          libraryId: number
          expectedRevision?: number
          rootId: number
          position?: number
          state?: 'active' | 'disabled' | 'pending_removal'
          patch?: { position?: number; state?: 'active' | 'disabled' | 'pending_removal'; path?: string }
        }
        if (local.patch?.path) {
          throw structuredError('INVALID_INPUT', '远程不能重绑根目录路径')
        }
        return mutate(
          'libraries.updateRoot',
          {
            libraryId: local.libraryId,
            rootId: local.rootId,
            ...(local.position != null || local.patch?.position != null
              ? { position: local.position ?? local.patch?.position }
              : {}),
            ...(local.state != null || local.patch?.state != null
              ? { state: local.state ?? local.patch?.state }
              : {})
          },
          libraryMutation(ctx, local.expectedRevision, 'L', true)
        )
      },
      removeRoot: mPlan('libraries.removeRoot'),
      cancelRootRemoval: libraryRevisionCommand('libraries.cancelRootRemoval'),
      runScan: m('scans.run'),
      cancelScan: m('scans.cancel'),
      latestScan: q('scans.getLatest'),
      auditGet: q('scans.auditGet'),
      auditHeader: q('scans.auditHeader'),
      auditPage: q('scans.auditPage'),
      auditViewPage: (input, ctx) => {
        const local = input
        return query(
          'scans.auditViewPage',
          {
            libraryId: local.libraryId,
            tab: local.tab,
            ...(local.outcome != null ? { outcome: local.outcome } : {}),
            ...(local.changesFilter != null ? { changesFilter: local.changesFilter } : {}),
            ...(local.search != null ? { search: local.search } : {}),
            ...(local.locale != null ? { locale: local.locale } : {}),
            ...(local.limit != null ? { limit: local.limit } : {}),
            ...(local.offset != null ? { offset: local.offset } : {}),
            ...(local.anchor != null ? { anchor: local.anchor } : {})
          },
          ctx?.signal
        )
      },
      getPendingScan: (input, ctx) =>
        query('pendingScan.get', { groupId: (input as { groupId: number }).groupId }, ctx?.signal),
      listPendingScans: q('pendingScan.list'),
      pagePendingScanQueue: q('pendingScan.queuePage'),
      countPendingScanQueue: q('pendingScan.queueCount'),
      getPendingResourceIdentity: (input, ctx) =>
        query(
          'pendingResourceIdentity.get',
          { identityId: (input as { identityId: number }).identityId },
          ctx?.signal
        ),
      listPendingResourceIdentities: q('pendingResourceIdentity.list'),
      pendingAuditPresence: (input, ctx) => {
        const local = (input ?? {}) as {
          libraryId: number
          groupIds?: number[]
          identityIds?: number[]
          scrapeIds?: number[]
        }
        return query(
          'pendingAudit.presence',
          {
            libraryId: local.libraryId,
            groupIds: local.groupIds ?? [],
            identityIds: local.identityIds ?? [],
            scrapeIds: local.scrapeIds ?? []
          },
          ctx?.signal
        )
      },
      previewRenameFile: q('files.renamePreview'),
      renameFile: mPlan('files.rename'),
      importManual: m('files.importManual'),
      resolvePendingScan: (input, ctx) => {
        const local = input as {
          groupId: number
          assignments: CatalogWireInput<'pendingScan.resolve'>['assignments']
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
    nfo: {
      getOptions: q('nfo.getOptions'),
      updatePreferences: m('nfo.updatePreferences'),
      plan: m('nfo.plan'),
      discardPlan: m('nfo.discardPlan'),
      start: m('nfo.start'),
      terminate: m('nfo.terminate'),
      state: q('nfo.state')
    },
    browser: {
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
      get: q('tasks.get'),
      list: q('tasks.list'),
      cancel: m('tasks.cancel'),
      async getOperation(input, ctx) {
        return query('operations.get', input, ctx?.signal)
      },
      createTargetList: m('targetLists.create'),
      countTargets: q('targetLists.count'),
      pageTargetList: q('targetLists.page')
    },
    pendingVideoScrapes: {
      count: q('pendingVideoScrapes.count'),
      existingIds: q('pendingVideoScrapes.existingIds'),
      page: q('pendingVideoScrapes.page'),
      get: q('pendingVideoScrapes.get'),
      list: q('pendingVideoScrapes.list'),
      replace: m('pendingVideoScrapes.replace'),
      confirm: m('pendingVideoScrapes.confirm'),
      discard: m('pendingVideoScrapes.discard')
    },
    agentMetadata: {
      findReady: q('agentMetadata.findReady'),
      apply: m('agentMetadata.apply'),
      discard: m('agentMetadata.discard')
    },
    assets: {
      async createUpload(input, ctx) {
        const result = await mutate('uploads.create', wire('uploads.create', input), ctx)
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
          }) as import('@shared/protocol/uploads').UploadInspectResult
        } finally {
          tracked.done()
        }
      },
      async grantPlayback(input, ctx) {
        const grant = await query('play.grant', input, ctx?.signal)
        if (
          grant &&
          typeof grant.playbackHandle === 'string' &&
          grant.playbackHandle.startsWith('/')
        ) {
          grant.playbackHandle = `${client.origin}${grant.playbackHandle}`
        }
        return grant
      },
      async readImage(input, ctx) {
        const tracked = trackSignal(ctx?.signal)
        try {
          const hello = await ensureConnected(tracked.signal)
          if (!secret) throw structuredError('RECOVERY_REQUIRED', '缺少写入凭据')
          const cache = cacheFor(hello.identity.catalogId)
          if (!tracked.signal.aborted) {
            const hit = cache?.get(input.relPath, input.size)
            if (hit) return hit
          }
          const image = await client.getAsset(input.relPath, {
            bearer: secret,
            signal: tracked.signal,
            size: input.size
          })
          if (!tracked.signal.aborted) cache?.set(input.relPath, image.mime, image.body, input.size)
          return image
        } finally {
          tracked.done()
        }
      }
    },
    migration: {
      preview: (input, ctx) => migrate('migration.preview', input, ctx?.signal),
      start: (input, ctx) => migrate('migration.start', input, ctx?.signal),
      status: (input, ctx) => migrate('migration.status', input, ctx?.signal),
      enable: (input, ctx) => migrate('migration.enable', input, ctx?.signal),
      abandon: (input, ctx) => migrate('migration.abandon', input, ctx?.signal),
      async putPackage(input, ctx) {
        const tracked = trackSignal(ctx?.signal)
        try {
          if (!options.migrationSecret) {
            throw structuredError('AUTH_REQUIRED', '缺少迁移凭据')
          }
          return (await client.putMigrationPackage(input.migrationId, input.body, {
            bearer: options.migrationSecret,
            signal: tracked.signal
          })) as { ok: true; bytes: number }
        } finally {
          tracked.done()
        }
      }
    },
    async dispose(): Promise<void> {
      abortInFlight()
      handshake = null
      secret = null
      sessionState = 'disconnected'
      sessionMessage = '已断开远程资料库'
    }
  }
}
