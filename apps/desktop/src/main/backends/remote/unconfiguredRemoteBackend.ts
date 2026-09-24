import { structuredError, type StructuredError } from '@shared/protocol/errors'
import type { CatalogBackend } from '../../application/catalogBackend'
import { rejectingCatalogSlice } from '../../application/catalogMethods'
import { createRemoteSessionCapabilities } from '../../application/desktopCapabilities'
import {
  EMPTY_DESKTOP_SESSION,
  type DesktopSessionState
} from '@shared/desktop/session'

export interface UnconfiguredRemoteBackendOptions {
  state?: DesktopSessionState
  message?: string
}

const UNCONFIGURED = structuredError(
  'CONNECTION_UNAVAILABLE',
  '远程资料库尚未配置。可修改此电脑设置、重试连接，或切回本地模式。'
)

async function rejectUnconfigured(): Promise<never> {
  throw UNCONFIGURED
}


/**
 * Remote placeholder when URL is missing or workStore copy is unfinished.
 * Does not open library.db, scan, recover, or Web.
 */
export function createUnconfiguredRemoteBackend(
  options: UnconfiguredRemoteBackendOptions = {}
): CatalogBackend {
  const state = options.state ?? 'disconnected'
  const message = options.message ?? UNCONFIGURED.message
  const session = () => ({
    ...EMPTY_DESKTOP_SESSION,
    state,
    mode: 'remote' as const,
    message
  })
  return {
    mode: 'remote',
    identity: { mode: 'remote', catalogId: '' },
    generation: 0,
    capabilities: () => createRemoteSessionCapabilities(state),
    session,
    async reconnect() {
      return session()
    },
    async claimWriter() {
      throw UNCONFIGURED
    },
    queries: rejectingCatalogSlice('queries', rejectUnconfigured),
    videos: rejectingCatalogSlice('videos', rejectUnconfigured),
    actresses: rejectingCatalogSlice('actresses', rejectUnconfigured),
    classifications: rejectingCatalogSlice('classifications', rejectUnconfigured),
    playlists: rejectingCatalogSlice('playlists', rejectUnconfigured),
    libraries: rejectingCatalogSlice('libraries', rejectUnconfigured),
    nfo: rejectingCatalogSlice('nfo', rejectUnconfigured),
    browser: rejectingCatalogSlice('browser', rejectUnconfigured),
    tasks: rejectingCatalogSlice('tasks', rejectUnconfigured),
    pendingVideoScrapes: rejectingCatalogSlice('pendingVideoScrapes', rejectUnconfigured),
    agentMetadata: rejectingCatalogSlice('agentMetadata', rejectUnconfigured),
    assets: rejectingCatalogSlice('assets', rejectUnconfigured),
    migration: rejectingCatalogSlice('migration', rejectUnconfigured),
    async dispose(): Promise<void> {
      return
    }
  }
}

export function isUnconfiguredRemoteError(error: unknown): error is StructuredError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as StructuredError).code === 'CONNECTION_UNAVAILABLE'
  )
}
