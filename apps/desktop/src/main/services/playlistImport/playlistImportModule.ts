import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  PlaylistImportControlCommand,
  PlaylistImportDestination,
  PlaylistImportModule,
  PlaylistImportSnapshot,
  PlaylistImportStartInput
} from '@shared/playlistImportTypes'
import { getDb } from '@library/db/database'
import type { CatalogBackend } from '../../application/catalogBackend'
import { agentRunStore } from '../../agent-platform/agentRunStore'
import {
  normalizePlaylistImportHost,
  PlaylistImportRepository,
  PlaylistImportTargetError
} from './playlistImportRepository'
import { applyPlaylistImportThroughCatalog } from './playlistImportCatalogApply'
import {
  createMemoryPlaylistImportCatalogLookup,
  type PlaylistImportCatalogLookup
} from './playlistImportCatalogLookup'

export async function validatePlaylistImportStartTargets(
  catalog: CatalogBackend,
  input: { targetLibraryId: number; destination: PlaylistImportDestination }
): Promise<{ id: number; name: string; playlistName?: string }> {
  if (catalog.mode === 'remote' && input.destination.kind === 'append') {
    throw new PlaylistImportTargetError(
      'UNSUPPORTED_CAPABILITY',
      '远程清单导入不能追加到已有清单；冻结 playlists.applyImport 只创建新清单。'
    )
  }
  const library = (await catalog.libraries.get({ libraryId: input.targetLibraryId })) as {
    id: number
    name: string
    status: string
  } | null
  if (!library || typeof library.status !== 'string' || typeof library.name !== 'string') {
    throw new PlaylistImportTargetError('TARGET_LIBRARY_NOT_FOUND', '目标媒体库不存在。')
  }
  if (library.status !== 'active') {
    throw new PlaylistImportTargetError('TARGET_LIBRARY_ARCHIVED', '目标媒体库已归档。')
  }
  if (input.destination.kind === 'append') {
    const playlist = (await catalog.playlists.get({
      playlistId: input.destination.playlistId
    })) as { id?: number; name?: string } | null
    if (!playlist || typeof playlist.name !== 'string') {
      throw new PlaylistImportTargetError('TARGET_PLAYLIST_NOT_FOUND', '追加目标清单不存在。')
    }
    return { id: library.id, name: library.name, playlistName: playlist.name }
  }
  return { id: library.id, name: library.name }
}

export interface PlaylistImportRunDriver {
  subscribe?(listener: (snapshot: PlaylistImportSnapshot) => void): () => void
  decorate?(snapshot: PlaylistImportSnapshot): PlaylistImportSnapshot
  create(
    runId: string,
    initialState: PlaylistImportSnapshot,
    onRunPersisted: () => void
  ): Promise<void>
  start(runId: string, input: PlaylistImportStartInput): Promise<void>
  resume(runId: string, requestId: string, idempotencyKey: string): Promise<PlaylistImportSnapshot>
  retry(runId: string, retryOperationKey: string): Promise<void>
  finish(runId: string): Promise<void>
  cancel(runId: string): Promise<void>
  discard(runId: string): Promise<void>
}

/**
 * Stable product-facing interface. Browser pagination, Agent runtime and SQLite staging remain
 * behind the run driver/repository seam rather than leaking into IPC or renderer callers.
 */
export class PlaylistImportModuleImpl implements PlaylistImportModule {
  private readonly listeners = new Set<(event: { runId: string; revision: number }) => void>()
  private readonly pendingRetryControls = new Map<string, {
    expectedRevision: number
    promise: Promise<PlaylistImportSnapshot>
  }>()

  constructor(
    private readonly database: () => Database.Database = getDb,
    private readonly driver: PlaylistImportRunDriver,
    private readonly catalog: CatalogBackend | null = null,
    private readonly catalogLookup?: PlaylistImportCatalogLookup
  ) {
    this.driver.subscribe?.((snapshot) => this.emit(snapshot))
  }

  private repository(): PlaylistImportRepository {
    return new PlaylistImportRepository(this.database(), this.catalogLookup)
  }

  subscribe(listener: (event: { runId: string; revision: number }) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(snapshot: PlaylistImportSnapshot): void {
    for (const listener of this.listeners) {
      listener({ runId: snapshot.runId, revision: snapshot.revision })
    }
  }

  private present(snapshot: PlaylistImportSnapshot): PlaylistImportSnapshot {
    return this.driver.decorate?.(snapshot) ?? snapshot
  }

  async start(input: PlaylistImportStartInput): Promise<PlaylistImportSnapshot> {
    const normalizedInput: PlaylistImportStartInput = {
      ...input,
      autoCreateUnmatchedVideos: input.autoCreateUnmatchedVideos ?? true,
      saveDetailLinks: input.saveDetailLinks ?? true,
      saveSourcePlaylistLink: input.saveSourcePlaylistLink ?? false
    }
    const key = normalizedInput.idempotencyKey.trim()
    if (!key) throw new Error('idempotencyKey 不能为空')
    const targetLibrary = this.catalog
      ? await validatePlaylistImportStartTargets(this.catalog, normalizedInput)
      : undefined
    const repository = this.repository()
    const expectedHash = repository.expectedInputHash(normalizedInput)
    const replay = repository.findByIdempotencyKey(key)
    if (replay) {
      if (replay.inputHash !== expectedHash) throw new Error('IDEMPOTENCY_KEY_REUSED')
      return this.present(repository.snapshot(replay.runId)!)
    }
    if (repository.activeRunId()) throw new Error('PLAYLIST_IMPORT_ALREADY_RUNNING')
    if (!targetLibrary) repository.validateStartTargets(normalizedInput)
    if (targetLibrary?.playlistName && this.catalogLookup?.rememberPlaylist && normalizedInput.destination.kind === 'append') {
      this.catalogLookup.rememberPlaylist(normalizedInput.destination.playlistId, targetLibrary.playlistName)
    }
    const runId = randomUUID()
    let createdRun = false
    let snapshot: PlaylistImportSnapshot | null = null
    try {
      // Create the generic Agent run, then initialize the foreground Session before the
      // runtime can publish its first observation.
      const provisional = provisionalSnapshot(runId, normalizedInput)
      await this.driver.create(runId, provisional, () => {
        createdRun = true
        snapshot = repository.createJob({
          ...normalizedInput,
          idempotencyKey: key,
          runId,
          ...(targetLibrary ? { targetLibrary } : {})
        })
      })
      if (!snapshot) throw new Error('PLAYLIST_IMPORT_SESSION_NOT_CREATED')
      await this.driver.start(runId, normalizedInput)
      snapshot = repository.snapshot(runId) ?? snapshot
      const presented = this.present(snapshot)
      this.emit(presented)
      return presented
    } catch (error) {
      if (createdRun) {
        const job = repository.snapshot(runId)
        if (job && !['completed', 'cancelled', 'failed'].includes(job.phase)) {
          repository.fail(
            runId,
            'START_FAILED',
            error instanceof Error ? error.message : String(error)
          )
        }
      }
      await this.driver.discard(runId)
      throw error
    }
  }

  snapshot(runId?: string): PlaylistImportSnapshot | null {
    const repository = this.repository()
    const selectedRunId = runId ?? repository.latestRunId()
    const snapshot = selectedRunId
      ? repository.snapshot(selectedRunId)
      : null
    return snapshot ? this.present(snapshot) : null
  }

  async control(
    runId: string,
    command: PlaylistImportControlCommand
  ): Promise<PlaylistImportSnapshot> {
    const repository = this.repository()
    if (command.kind === 'cancel') {
      const snapshot = repository.cancel(runId)
      await this.driver.cancel(runId)
      const presented = this.present(snapshot)
      this.emit(presented)
      return presented
    }
    if (command.kind === 'resume-browser') {
      const snapshot = await this.driver.resume(
        runId,
        command.requestId,
        command.idempotencyKey
      )
      const presented = this.present(snapshot)
      this.emit(presented)
      return presented
    }
    if (command.kind === 'retry') {
      const pendingKey = `${runId}:${command.idempotencyKey}`
      const pending = this.pendingRetryControls.get(pendingKey)
      if (pending) {
        if (pending.expectedRevision !== command.expectedRevision) {
          throw new Error('IDEMPOTENCY_KEY_REUSED')
        }
        return pending.promise
      }
      const promise = this.executeRetryControl(repository, runId, command)
      this.pendingRetryControls.set(pendingKey, {
        expectedRevision: command.expectedRevision,
        promise
      })
      try {
        return await promise
      } finally {
        if (this.pendingRetryControls.get(pendingKey)?.promise === promise) {
          this.pendingRetryControls.delete(pendingKey)
        }
      }
    }
    let snapshot = repository.resolveIdentityDecisions({
      runId,
      expectedRevision: command.expectedRevision,
      idempotencyKey: command.idempotencyKey,
      decisions: command.decisions
    })
    if (snapshot.phase === 'ready-to-apply') {
      try {
        if (this.catalog?.mode === 'remote') {
          await applyPlaylistImportThroughCatalog(
            this.catalog,
            repository,
            runId,
            `identity-apply:${command.idempotencyKey}`
          )
        } else {
          repository.apply(runId, `identity-apply:${command.idempotencyKey}`)
        }
        snapshot = repository.snapshot(runId)!
      } catch (error) {
        const failed = repository.snapshot(runId)
        if (failed?.phase === 'failed') {
          await this.driver.finish(runId)
          const presented = this.present(failed)
          this.emit(presented)
          return presented
        }
        if (!(error instanceof Error) || error.message !== 'IMPORT_PREVIEW_STALE') throw error
        snapshot = repository.snapshot(runId)!
        if (!['resolving-identities', 'waiting_user'].includes(snapshot.phase)) throw error
        let presented = this.present(snapshot)
        this.emit(presented)
        if (snapshot.phase === 'resolving-identities') {
          try {
            await this.driver.retry(runId, `preview-stale:${command.idempotencyKey}`)
            snapshot = repository.snapshot(runId)!
            presented = this.present(snapshot)
            this.emit(presented)
          } catch (retryError) {
            snapshot = repository.snapshot(runId)!
            if (snapshot.phase !== 'failed' && !snapshot.error?.retryable) {
              snapshot = repository.fail(
                runId,
                'PLAYLIST_IMPORT_RETRY_FAILED',
                retryError instanceof Error ? retryError.message : String(retryError)
              )
            }
            presented = this.present(snapshot)
            this.emit(presented)
          }
        }
        return presented
      }
    }
    if (['completed', 'failed', 'cancelled'].includes(snapshot.phase)) {
      await this.driver.finish(runId)
    }
    const presented = this.present(snapshot)
    this.emit(presented)
    return presented
  }

  private async executeRetryControl(
    repository: PlaylistImportRepository,
    runId: string,
    command: Extract<PlaylistImportControlCommand, { kind: 'retry' }>
  ): Promise<PlaylistImportSnapshot> {
    let snapshot = repository.snapshot(runId)
    if (!snapshot) throw new Error('PLAYLIST_IMPORT_NOT_FOUND')
    if (snapshot.revision !== command.expectedRevision) {
      throw new Error('PLAYLIST_IMPORT_REVISION_STALE')
    }
    if (!snapshot.error?.retryable) throw new Error('PLAYLIST_IMPORT_RETRY_NOT_AVAILABLE')
    if (snapshot.phase === 'ready-to-apply') {
      try {
        if (this.catalog?.mode === 'remote') {
          await applyPlaylistImportThroughCatalog(
            this.catalog,
            repository,
            runId,
            `retry-apply:${command.idempotencyKey}`
          )
        } else {
          repository.apply(runId, `retry-apply:${command.idempotencyKey}`)
        }
      } catch {
        // The foreground Session records retryable apply errors and stale-preview transitions.
      }
      snapshot = repository.snapshot(runId)!
    }
    if (['discovering-list', 'resolving-identities'].includes(snapshot.phase)) {
      await this.driver.retry(runId, command.idempotencyKey)
      snapshot = repository.snapshot(runId)!
    }
    if (['completed', 'failed', 'cancelled'].includes(snapshot.phase)) {
      await this.driver.finish(runId)
    }
    const presented = this.present(snapshot)
    this.emit(presented)
    return presented
  }
}

function provisionalSnapshot(
  runId: string,
  input: PlaylistImportStartInput
): PlaylistImportSnapshot {
  const url = new URL(input.sourceUrl)
  return {
    runId,
    revision: 1,
    cursor: 1,
    phase: 'discovering-list',
    summary: '正在准备外部清单导入',
    frozenInput: {
      sourceUrl: input.sourceUrl,
      displayUrl: input.sourceUrl,
      sourceHost: normalizePlaylistImportHost(url.hostname),
      targetLibraryId: input.targetLibraryId,
      targetLibraryNameAtStart: '',
      destination: structuredClone(input.destination),
      autoCreateUnmatchedVideos: input.autoCreateUnmatchedVideos ?? true,
      saveDetailLinks: input.saveDetailLinks ?? true,
      saveSourcePlaylistLink: input.saveSourcePlaylistLink ?? false,
      policyVersion: 1
    },
    progress: {
      pagesRead: 0,
      scrollWindowsRead: 0,
      sourceItems: 0,
      uniqueItems: 0,
      directReuses: 0,
      detailPending: 0,
      userDecisionsPending: 0,
      plannedCreates: 0,
      skippedItems: 0,
      appliedItems: 0
    }
  }
}

export async function createPlaylistImportModule(options?: {
  database?: () => Database.Database
  catalog?: CatalogBackend | null
}): Promise<PlaylistImportModule> {
  const { playlistImportRunDriver } = await import('./playlistImportRunDriver')
  const database = options?.database ?? getDb
  const catalogLookup =
    options?.catalog?.mode === 'remote' ? createMemoryPlaylistImportCatalogLookup() : undefined
  playlistImportRunDriver.bindDatabase(database)
  playlistImportRunDriver.bindCatalog(options?.catalog ?? null, catalogLookup)
  for (const id of agentRunStore.iterateRecoverableRunIds('playlist-importer')) {
    agentRunStore.closeRun(id)
  }
  return new PlaylistImportModuleImpl(
    database,
    playlistImportRunDriver,
    options?.catalog ?? null,
    catalogLookup
  )
}
