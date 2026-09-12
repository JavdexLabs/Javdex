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
      async homeLoad(input, ctx) {
        return query('home.load', input, ctx?.signal)
      },
      async listVideos(input, ctx) {
        return query('videos.list', input, ctx?.signal)
      },
      async getVideo(input, ctx) {
        return query('videos.get', input, ctx?.signal)
      },
      async overviewStats(input, ctx) {
        return query('catalog.overviewStats', input ?? {}, ctx?.signal)
      }
    },
    videos: {
      ...rejectSlice(VIDEO_KEYS, (key) => unsupported(`videos.${String(key)}`)),
      async edit(input, ctx) {
        const result = (await mutate('videos.edit', input, ctx)) as { ok?: boolean }
        return result.ok
      },
      async setPoster(input, ctx) {
        return mutate('videos.setPoster', input, ctx)
      },
      async importSamples(input, ctx) {
        return mutate('videos.importSamples', input, ctx)
      }
    },
    actresses: rejectSlice(ACTRESS_KEYS, (key) => unsupported(`actresses.${String(key)}`)),
    classifications: {
      ...rejectSlice(CLASSIFICATION_KEYS, (key) => unsupported(`classifications.${String(key)}`)),
      async setImage(input, ctx) {
        return mutate('classificationImages.set', input, ctx)
      }
    },
    playlists: {
      ...rejectSlice(PLAYLIST_KEYS, (key) => unsupported(`playlists.${String(key)}`)),
      async create(input, ctx) {
        return mutate('playlists.create', input, ctx)
      },
      async update(input, ctx) {
        return mutate('playlists.update', input, ctx)
      }
    },
    libraries: {
      ...rejectSlice(LIBRARY_KEYS, (key) => unsupported(`libraries.${String(key)}`)),
      async list(input, ctx) {
        return query('libraries.list', input ?? {}, ctx?.signal)
      }
    },
    nfo: rejectSlice(NFO_KEYS, (key) => unsupported(`nfo.${String(key)}`)),
    browser: rejectSlice(BROWSER_KEYS, (key) => unsupported(`browser.${String(key)}`)),
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
