import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'
import type { AgentBrowserObservation } from '../../scrapers/scrapeBrowserTypes'
import type {
  ScrapeBrowserListExtraction,
  ScrapeBrowserListExtractionPlan
} from '../../scrapers/scrapeBrowserTypes'
import type { AgentMetadataBrowserAdapter } from '../agentMetadata/browserAdapter'
import { migrateDatabase } from '../../db/migrations'
import { agentExecution } from '../../agent-platform/agentExecution'
import { PlaylistImportRepository } from './playlistImportRepository'
import { PlaylistImportModuleImpl } from './playlistImportModule'
import {
  PlaylistImportAgentRunDriver,
  playlistImportRecoverableToolFailure
} from './playlistImportRunDriver'

type ToolContext = {
  runId: string
  callId: string
  args: Record<string, unknown>
  signal: AbortSignal
  progress(summary: string): void
}

interface ScriptedWindow {
  positions: number[]
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  atEnd: boolean
  loadMoreAvailable?: boolean
}

class ScriptedVirtualBrowser {
  private windowIndex = 0
  private revision = 0
  private expanded = false
  readonly actions: string[] = []
  readonly evidenceByRevision = new Map<string, string>()
  private currentUrl: string

  constructor(
    readonly url: string,
    private readonly initialWindows: ScriptedWindow[],
    private readonly expandedWindows: ScriptedWindow[] = [],
    private readonly expectedPositionBase: 0 | 1 = 0,
    private readonly skipWindowOnHalfViewport = false
  ) {
    this.currentUrl = url
  }

  private windows(): ScriptedWindow[] {
    return this.expanded ? this.expandedWindows : this.initialWindows
  }

  private current(): ScriptedWindow {
    return this.windows()[Math.min(this.windowIndex, this.windows().length - 1)]!
  }

  private viewRevision(): string {
    return `1:1:${this.revision}`
  }

  source(): { displayUrl: string } {
    return { displayUrl: this.currentUrl }
  }

  observation(): { documentRevision: string; viewRevision: string } {
    return { documentRevision: '1:1', viewRevision: this.viewRevision() }
  }

  assertEvidenceRefs(): void {}

  assertCurrentEvidenceRef(
    _runId: string,
    evidenceRef: string,
    expected: { documentRevision: string; viewRevision: string }
  ): void {
    assert.equal(expected.documentRevision, '1:1')
    assert.equal(this.evidenceByRevision.get(expected.viewRevision), evidenceRef)
  }

  async hostAction(input: {
    command: { action: string; direction?: string; amount?: string; url?: string }
  }): Promise<AgentBrowserObservation> {
    const before = this.current()
    let moved = false
    if (input.command.action === 'scroll' && input.command.direction === 'start') {
      this.windowIndex = 0
      moved = before.scrollTop > 0
      this.actions.push('scroll:start')
    } else if (input.command.action === 'scroll') {
      const step = this.skipWindowOnHalfViewport && input.command.amount === 'half-viewport'
        ? 2
        : 1
      const nextIndex = input.command.direction === 'up'
        ? Math.max(0, this.windowIndex - step)
        : Math.min(this.windows().length - 1, this.windowIndex + step)
      moved = nextIndex !== this.windowIndex
      this.windowIndex = nextIndex
      this.actions.push(this.skipWindowOnHalfViewport
        ? `scroll:${input.command.direction}:${input.command.amount}:${moved ? 'moved' : 'stable'}`
        : `scroll:down:${moved ? 'moved' : 'stable'}`)
    } else if (input.command.action === 'click') {
      this.expanded = true
      this.windowIndex = 0
      moved = true
      this.actions.push('click:load-more')
    } else if (input.command.action === 'wait') {
      this.actions.push('wait')
    } else if (input.command.action === 'open') {
      if (input.command.url) this.currentUrl = input.command.url
      this.windowIndex = 0
      this.actions.push('open')
    }
    this.revision += 1
    const after = this.current()
    return {
      action: input.command.action as AgentBrowserObservation['action'],
      url: this.url,
      documentRevision: '1:1',
      viewRevision: this.viewRevision(),
      scrollState: {
        containerFingerprint: 'virtual-list',
        before: {
          scrollTop: before.scrollTop,
          scrollHeight: before.scrollHeight,
          clientHeight: before.clientHeight
        },
        after: {
          scrollTop: after.scrollTop,
          scrollHeight: after.scrollHeight,
          clientHeight: after.clientHeight
        },
        deltaY: after.scrollTop - before.scrollTop,
        moved,
        atStart: after.scrollTop <= 0.5,
        atEnd: after.atEnd,
        settled: true
      }
    }
  }

  async extractList(input: {
    plan: ScrapeBrowserListExtractionPlan
  }): Promise<ScrapeBrowserListExtraction> {
    if (input.plan.containerSelector) {
      assert.equal(input.plan.containerSelector, '#virtual-list')
      assert.deepEqual(input.plan.position, {
        kind: 'attribute',
        name: 'data-index',
        base: this.expectedPositionBase
      })
    }
    const current = this.current()
    return {
      url: this.currentUrl,
      title: 'Virtual collection',
      documentRevision: '1:1',
      viewRevision: this.viewRevision(),
      items: current.positions.map((position) => ({
        code: `V-${position}`,
        detailUrl: `${this.url}/video/${position}`,
        absolutePosition: position,
        occurrenceKey: `${position}:${this.url}/video/${position}`
      })),
      nextPageUrls: [],
      terminalVerified: current.atEnd,
      loadMoreAvailable: current.loadMoreAvailable,
      containerFingerprint: 'virtual-list',
      scrollState: {
        containerFingerprint: 'virtual-list',
        before: {
          scrollTop: current.scrollTop,
          scrollHeight: current.scrollHeight,
          clientHeight: current.clientHeight
        },
        after: {
          scrollTop: current.scrollTop,
          scrollHeight: current.scrollHeight,
          clientHeight: current.clientHeight
        },
        deltaY: 0,
        moved: false,
        atStart: current.scrollTop <= 0.5,
        atEnd: current.atEnd,
        settled: true
      }
    }
  }

  async captureEvidence(): Promise<{
    evidenceRef: string
    documentRevision: string
    viewRevision: string
  }> {
    const viewRevision = this.viewRevision()
    const evidenceRef = `.javdex/browser/${viewRevision.replaceAll(':', '-')}.json`
    this.evidenceByRevision.set(viewRevision, evidenceRef)
    this.assertCurrentEvidenceRef('', evidenceRef, { documentRevision: '1:1', viewRevision })
    return { evidenceRef, documentRevision: '1:1', viewRevision }
  }

  async release(): Promise<void> {}
}

function fixture(runId: string, sourceUrl: string): {
  database: Database.Database
  repository: PlaylistImportRepository
  driver: PlaylistImportAgentRunDriver
} {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  migrateDatabase(database)
  database.prepare(
    `INSERT INTO agent_runs (
      id, use_case, status, config_revision, config_snapshot_json,
      runtime_id, product_state_json, created_at, updated_at
    ) VALUES (?, 'playlist-importer', 'running', '1', '{}', 'pi', '{}', ?, ?)`
  ).run(runId, new Date().toISOString(), new Date().toISOString())
  const repository = new PlaylistImportRepository(database)
  repository.createJob({
    runId,
    idempotencyKey: `start:${runId}`,
    sourceUrl,
    targetLibraryId: 1,
    destination: { kind: 'create', requestedName: 'Scripted import' }
  })
  return { database, repository, driver: new PlaylistImportAgentRunDriver() }
}

function installScriptedDependencies(
  driver: PlaylistImportAgentRunDriver,
  repository: PlaylistImportRepository,
  browser: ScriptedVirtualBrowser
): void {
  const mutable = driver as unknown as Record<string, unknown>
  Object.defineProperty(mutable, 'repository', { value: () => repository, configurable: true })
  Object.defineProperty(mutable, 'browser', {
    value: browser as unknown as AgentMetadataBrowserAdapter,
    configurable: true
  })
  Object.defineProperty(mutable, 'emit', { value: () => undefined, configurable: true })
  Object.defineProperty(mutable, 'decorate', {
    value: (snapshot: unknown) => snapshot,
    configurable: true
  })
  Object.defineProperty(mutable, 'describeTool', { value: () => undefined, configurable: true })
}

function replaceMethod<T extends object, K extends keyof T>(
  target: T,
  key: K,
  replacement: T[K]
): () => void {
  const mutable = target as unknown as Record<PropertyKey, unknown>
  const original = mutable[key]
  mutable[key] = replacement
  return () => { mutable[key] = original }
}

async function invoke(
  driver: PlaylistImportAgentRunDriver,
  runId: string,
  name: string,
  args: Record<string, unknown>,
  callId: string
): Promise<void> {
  const handler = driver.createToolHandlers(runId).get(name)
  assert.ok(handler)
  await handler({
    runId,
    callId,
    args,
    signal: new AbortController().signal,
    progress: () => undefined
  } satisfies ToolContext)
}

function virtualStartArgs(
  advance: Record<string, unknown>,
  declaredTotalItems?: number,
  positionBase: 0 | 1 = 0
): Record<string, unknown> {
  return {
    kind: 'virtual-page-start',
    evidenceRef: '.javdex/browser/initial.json',
    extraction: {
      candidateSelector: '.item',
      detailLinkSelector: 'a',
      codeSelector: '.code'
    },
    enumeration: {
      containerSelector: '#virtual-list',
      positionKind: 'attribute',
      positionAttribute: 'data-index',
      positionBase
    },
    advance,
    ...(declaredTotalItems != null ? { declaredTotalItems } : {}),
    declaredTotalPages: 1
  }
}

describe('PlaylistImportAgentRunDriver scripted browser integration', () => {
  it('replays a committed static page checkpoint after its response is lost', async () => {
    const runId = 'run-driver-static-response-lost'
    const sourceUrl = 'https://example.test/static'
    const { database, repository, driver } = fixture(runId, sourceUrl)
    const browser = new ScriptedVirtualBrowser(sourceUrl, [{
      positions: [0],
      scrollTop: 0,
      scrollHeight: 200,
      clientHeight: 200,
      atEnd: true
    }])
    installScriptedDependencies(driver, repository, browser)
    try {
      const evidence = await browser.captureEvidence()
      const args = {
        kind: 'static-page',
        evidenceRef: evidence.evidenceRef,
        extraction: {
          candidateSelector: '.item',
          detailLinkSelector: 'a',
          codeSelector: '.code'
        },
        advance: { kind: 'terminal', reason: 'known-total-reached' },
        declaredTotalItems: 1,
        declaredTotalPages: 1
      }
      await invoke(driver, runId, 'checkpoint_playlist_page', args, 'static-first')
      const first = repository.snapshot(runId)!
      assert.equal(first.phase, 'completed')

      await invoke(driver, runId, 'checkpoint_playlist_page', args, 'static-replay')
      const replay = repository.snapshot(runId)!
      assert.equal(replay.phase, 'completed')
      assert.equal(replay.outcome?.totalItems, 1)
      assert.equal((database.prepare(
        'SELECT COUNT(*) AS value FROM playlist_import_pages WHERE run_id = ?'
      ).get(runId) as { value: number }).value, 1)
    } finally {
      database.close()
    }
  })

  it('replays a committed detail checkpoint after its response is lost', async () => {
    const runId = 'run-driver-detail-response-lost'
    const sourceUrl = 'https://example.test/list'
    const { database, repository, driver } = fixture(runId, sourceUrl)
    database.exec(`
      INSERT INTO videos (id, code, title) VALUES
        (91, 'DUP-91', 'First'),
        (92, 'DUP-91', 'Second');
    `)
    repository.checkpointStaticPage({
      runId,
      pageKey: 'page',
      pageOrder: 0,
      pageUrl: sourceUrl,
      documentRevision: '1:1',
      viewRevision: '1:1:0',
      evidenceRef: '.javdex/browser/list.json',
      items: [{ code: 'DUP-91', detailUrl: 'https://example.test/video/dup-91' }],
      nextPageUrls: [],
      terminal: true
    })
    const browser = new ScriptedVirtualBrowser(sourceUrl, [{
      positions: [0],
      scrollTop: 0,
      scrollHeight: 200,
      clientHeight: 200,
      atEnd: true
    }])
    installScriptedDependencies(driver, repository, browser)
    try {
      await invoke(driver, runId, 'open_playlist_item_detail', {}, 'open-detail')
      const work = repository.nextBrowserWork(runId)
      assert.equal(work?.kind, 'detail')
      const evidence = await browser.captureEvidence()
      const args = {
        itemId: work!.kind === 'detail' ? work.itemId : 0,
        expectedItemRevision: work!.kind === 'detail' ? work.itemRevision : 0,
        documentRevision: evidence.documentRevision,
        viewRevision: evidence.viewRevision,
        detailCode: 'DUP-91',
        identity: {},
        evidenceRef: evidence.evidenceRef
      }
      await invoke(driver, runId, 'checkpoint_playlist_detail', args, 'detail-first')
      const first = repository.snapshot(runId)!
      assert.equal(first.phase, 'waiting_user')

      await invoke(driver, runId, 'checkpoint_playlist_detail', args, 'detail-replay')
      const replay = repository.snapshot(runId)!
      assert.equal(replay.phase, 'waiting_user')
      assert.equal(replay.progress.userDecisionsPending, 1)
    } finally {
      database.close()
    }
  })

  it('restarts the changed dynamic page from its inbound frontier on product retry', async () => {
    const runId = 'run-driver-page-changed-retry'
    const sourceUrl = 'https://example.test/list'
    const { database, repository, driver } = fixture(runId, sourceUrl)
    const browser = new ScriptedVirtualBrowser(sourceUrl, [{
      positions: [0],
      scrollTop: 0,
      scrollHeight: 400,
      clientHeight: 200,
      atEnd: false
    }])
    installScriptedDependencies(driver, repository, browser)
    const base = {
      runId,
      pageKey: 'dynamic-page',
      pageOrder: 0,
      pageUrl: sourceUrl,
      documentRevision: '1:1',
      initialViewRevision: '1:1:0',
      evidenceRef: '.javdex/browser/list.json',
      operationKey: 'dynamic:start',
      batchOrder: 0,
      viewRevision: '1:1:0',
      positionMode: 'attribute' as const,
      containerFingerprint: 'virtual-list',
      scrollState: {
        scrollTop: 0,
        scrollHeight: 400,
        clientHeight: 200,
        atStart: true,
        atEnd: false,
        moved: false,
        settled: true
      },
      items: [{
        occurrenceKey: '0:https://example.test/video/old',
        absolutePosition: 0,
        code: 'OLD-1',
        detailUrl: 'https://example.test/video/old'
      }],
      accumulatedSequenceDigest: 'old',
      terminalProbeCount: 0,
      seal: false,
      nextPageUrls: [],
      containerContract: {
        plan: {
          candidateSelector: '.item',
          detailLinkSelector: 'a',
          containerSelector: '#virtual-list',
          position: { kind: 'attribute', name: 'data-index', base: 0 }
        },
        advance: { kind: 'terminal', reason: 'known-total-reached' }
      }
    }
    repository.checkpointVirtualBatch(base)
    const changed = repository.checkpointVirtualBatch({
      ...base,
      items: [{
        occurrenceKey: '0:https://example.test/video/new',
        absolutePosition: 0,
        code: 'NEW-1',
        detailUrl: 'https://example.test/video/new'
      }],
      accumulatedSequenceDigest: 'new'
    })
    assert.equal(changed.error?.code, 'PAGE_CHANGED')
    let dispatches = 0
    Object.defineProperty(driver as unknown as Record<string, unknown>, 'restoreRun', {
      value: async () => repository.snapshot(runId)!,
      configurable: true
    })
    Object.defineProperty(driver as unknown as Record<string, unknown>, 'dispatchRecovery', {
      value: async () => {
        await (driver as unknown as {
          restoreCurrentBrowserWork(id: string, signal: AbortSignal): Promise<unknown>
        }).restoreCurrentBrowserWork(runId, new AbortController().signal)
        dispatches += 1
      },
      configurable: true
    })
    try {
      const module = new PlaylistImportModuleImpl(() => database, driver)
      const recovered = await module.control(runId, {
        kind: 'retry',
        expectedRevision: changed.revision,
        idempotencyKey: 'retry-page-changed'
      })
      assert.equal(recovered.phase, 'discovering-list')
      assert.equal(recovered.error, undefined)
      assert.equal(dispatches, 1)
      assert.equal(repository.openDynamicPage(runId), null)
      assert.equal(repository.nextBrowserWork(runId)?.url, sourceUrl)
      assert.equal(browser.actions.includes('open'), true)
    } finally {
      database.close()
    }
  })

  it('restarts a dynamic page with corrected declared totals after one product retry', async () => {
    const runId = 'run-driver-total-mismatch-retry'
    const sourceUrl = 'https://example.test/total-mismatch'
    const { database, repository, driver } = fixture(runId, sourceUrl)
    const browser = new ScriptedVirtualBrowser(sourceUrl, [{
      positions: [0],
      scrollTop: 0,
      scrollHeight: 200,
      clientHeight: 200,
      atEnd: true
    }])
    installScriptedDependencies(driver, repository, browser)
    const originalMarkEffect = PlaylistImportRepository.prototype.markRetryControlEffectCompleted
    let failMarkEffect = true
    PlaylistImportRepository.prototype.markRetryControlEffectCompleted = function (...args) {
      if (failMarkEffect) {
        failMarkEffect = false
        throw new Error('simulated restart after recovery dispatch')
      }
      return originalMarkEffect.apply(this, args)
    }
    try {
      await invoke(driver, runId, 'checkpoint_playlist_page', virtualStartArgs({
        kind: 'terminal',
        reason: 'known-total-reached'
      }, 2), 'wrong-total-start')
      await invoke(driver, runId, 'advance_playlist_page', {}, 'wrong-total-probe-1')
      await invoke(driver, runId, 'advance_playlist_page', {}, 'wrong-total-probe-2')

      const mismatch = repository.snapshot(runId)!
      assert.equal(mismatch.phase, 'discovering-list')
      assert.equal(mismatch.error?.code, 'TOTAL_MISMATCH')
      assert.ok(repository.openDynamicPage(runId))

      Object.defineProperty(driver as unknown as Record<string, unknown>, 'restoreRun', {
        value: async () => repository.snapshot(runId)!,
        configurable: true
      })
      const recoveryDispatchKeys = new Set<string>()
      Object.defineProperty(driver as unknown as Record<string, unknown>, 'dispatchRecovery', {
        value: async (_runId: string, _revision: number, retryOperationKey?: string) => {
          await (driver as unknown as {
            restoreCurrentBrowserWork(id: string, signal: AbortSignal): Promise<unknown>
          }).restoreCurrentBrowserWork(runId, new AbortController().signal)
          assert.ok(retryOperationKey)
          recoveryDispatchKeys.add(retryOperationKey)
        },
        configurable: true
      })
      const module = new PlaylistImportModuleImpl(() => database, driver)
      const retry = {
        kind: 'retry',
        expectedRevision: mismatch.revision,
        idempotencyKey: 'retry-total-mismatch'
      } as const
      await assert.rejects(module.control(runId, retry), /simulated restart/)
      const restartedModule = new PlaylistImportModuleImpl(() => database, driver)
      const recovered = await restartedModule.control(runId, retry)
      assert.equal(recovered.phase, 'discovering-list')
      assert.equal(recovered.error, undefined)
      assert.equal(repository.openDynamicPage(runId), null)
      assert.equal(repository.nextBrowserWork(runId)?.url, sourceUrl)
      assert.equal(recoveryDispatchKeys.size, 1)
      assert.deepEqual([...recoveryDispatchKeys], ['retry-total-mismatch'])

      await invoke(driver, runId, 'checkpoint_playlist_page', virtualStartArgs({
        kind: 'terminal',
        reason: 'known-total-reached'
      }, 1), 'correct-total-start')
      await invoke(driver, runId, 'advance_playlist_page', {}, 'correct-total-probe-1')
      if (repository.snapshot(runId)?.phase === 'discovering-list') {
        await invoke(driver, runId, 'advance_playlist_page', {}, 'correct-total-probe-2')
      }

      const completed = repository.snapshot(runId)!
      assert.equal(completed.phase, 'completed')
      assert.equal(completed.error, undefined)
      assert.equal(completed.outcome?.sourceItems, 1)
    } finally {
      PlaylistImportRepository.prototype.markRetryControlEffectCompleted = originalMarkEffect
      database.close()
    }
  })

  it('records an evidence-backed unsupported pagination report as an explicit terminal error', async () => {
    const runId = 'run-driver-unsupported-pagination'
    const sourceUrl = 'https://example.test/infinite'
    const { database, repository, driver } = fixture(runId, sourceUrl)
    const browser = new ScriptedVirtualBrowser(sourceUrl, [{
      positions: [0],
      scrollTop: 0,
      scrollHeight: 400,
      clientHeight: 200,
      atEnd: false
    }])
    installScriptedDependencies(driver, repository, browser)
    try {
      const evidence = await browser.captureEvidence()
      await invoke(driver, runId, 'report_playlist_import_failure', {
        code: 'UNSUPPORTED_PAGINATION',
        reason: 'unbounded-feed',
        documentRevision: evidence.documentRevision,
        viewRevision: evidence.viewRevision,
        evidenceRef: evidence.evidenceRef
      }, 'report-unsupported')
      const failed = repository.snapshot(runId)!
      assert.equal(failed.phase, 'failed')
      assert.equal(failed.error?.code, 'UNSUPPORTED_PAGINATION')
      assert.equal(failed.error?.retryable, false)
    } finally {
      database.close()
    }
  })
  it('requires a page checkpoint before advancing away from the current list page', async () => {
    const runId = 'run-driver-checkpoint-required'
    const sourceUrl = 'https://example.test/list'
    const { database, repository, driver } = fixture(runId, sourceUrl)
    const browser = new ScriptedVirtualBrowser(sourceUrl, [{
      positions: [0, 1],
      scrollTop: 0,
      scrollHeight: 800,
      clientHeight: 200,
      atEnd: false
    }])
    installScriptedDependencies(driver, repository, browser)
    try {
      await invoke(driver, runId, 'advance_playlist_page', {}, 'advance-without-checkpoint')
      const blocked = repository.snapshot(runId)!
      assert.equal(blocked.phase, 'discovering-list')
      assert.equal(blocked.error?.code, 'PAGE_CHECKPOINT_REQUIRED')
      assert.equal(blocked.error?.retryable, true)
      assert.deepEqual(browser.actions, [])

      await invoke(driver, runId, 'checkpoint_playlist_page', virtualStartArgs({
        kind: 'terminal',
        reason: 'known-total-reached'
      }, 2), 'checkpoint-after-block')
      assert.equal(repository.snapshot(runId)?.error, undefined)
    } finally {
      database.close()
    }
  })

  it('checkpoints a finite recycled virtual list without gaps and binds evidence to every view', async () => {
    const runId = 'run-driver-virtual'
    const sourceUrl = 'https://example.test/virtual'
    const { database, repository, driver } = fixture(runId, sourceUrl)
    const browser = new ScriptedVirtualBrowser(sourceUrl, [
      { positions: [0, 1], scrollTop: 0, scrollHeight: 800, clientHeight: 200, atEnd: false },
      { positions: [1, 2, 3], scrollTop: 600, scrollHeight: 800, clientHeight: 200, atEnd: true }
    ])
    installScriptedDependencies(driver, repository, browser)
    try {
      await invoke(driver, runId, 'checkpoint_playlist_page', virtualStartArgs({
        kind: 'terminal',
        reason: 'known-total-reached'
      }, 4), 'checkpoint-start')
      await invoke(driver, runId, 'advance_playlist_page', {}, 'advance-window')
      await invoke(driver, runId, 'advance_playlist_page', {}, 'terminal-probe-1')
      await invoke(driver, runId, 'advance_playlist_page', {}, 'terminal-probe-2')

      const completed = repository.snapshot(runId)!
      assert.equal(completed.phase, 'completed')
      assert.equal(completed.outcome?.sourceItems, 4)
      assert.equal(completed.outcome?.uniqueDetailUrls, 4)
      assert.deepEqual(
        database.prepare(
          `SELECT batch_order, view_revision, evidence_ref
           FROM playlist_import_scroll_batches ORDER BY batch_order`
        ).all(),
        [
          { batch_order: 0, view_revision: '1:1:1', evidence_ref: '.javdex/browser/1-1-1.json' },
          ...[2, 3, 4].map((revision, index) => ({
            batch_order: index + 1,
            view_revision: `1:1:${revision}`,
            evidence_ref: `.javdex/browser/1-1-${revision}.json`
          }))
        ]
      )
      assert.equal(browser.actions.filter((action) => action.startsWith('scroll:down')).length, 3)
    } finally {
      database.close()
    }
  })

  it('normalizes a one-based stable position attribute into a continuous virtual list', async () => {
    const runId = 'run-driver-virtual-one-based'
    const sourceUrl = 'https://example.test/virtual-one-based'
    const { database, repository, driver } = fixture(runId, sourceUrl)
    const browser = new ScriptedVirtualBrowser(sourceUrl, [
      { positions: [0, 1], scrollTop: 0, scrollHeight: 800, clientHeight: 200, atEnd: false },
      { positions: [1, 2], scrollTop: 600, scrollHeight: 800, clientHeight: 200, atEnd: true }
    ], [], 1)
    installScriptedDependencies(driver, repository, browser)
    try {
      await invoke(driver, runId, 'checkpoint_playlist_page', virtualStartArgs({
        kind: 'terminal',
        reason: 'known-total-reached'
      }, 3, 1), 'one-based-start')
      await invoke(driver, runId, 'advance_playlist_page', {}, 'one-based-bottom')
      await invoke(driver, runId, 'advance_playlist_page', {}, 'one-based-probe')
      await invoke(driver, runId, 'advance_playlist_page', {}, 'one-based-confirm')

      assert.equal(repository.snapshot(runId)?.phase, 'completed')
      assert.deepEqual(
        repository.openDynamicPage(runId),
        null,
        'the one-based attribute should seal without a continuity gap'
      )
    } finally {
      database.close()
    }
  })

  it('backtracks to the last anchor and halves the step when variable heights skip a window', async () => {
    const runId = 'run-driver-variable-height'
    const sourceUrl = 'https://example.test/variable-height'
    const { database, repository, driver } = fixture(runId, sourceUrl)
    const browser = new ScriptedVirtualBrowser(sourceUrl, [
      { positions: [0, 1], scrollTop: 0, scrollHeight: 1_200, clientHeight: 200, atEnd: false },
      { positions: [1, 2], scrollTop: 100, scrollHeight: 1_200, clientHeight: 200, atEnd: false },
      { positions: [3, 4], scrollTop: 200, scrollHeight: 1_200, clientHeight: 200, atEnd: true }
    ], [], 0, true)
    installScriptedDependencies(driver, repository, browser)
    try {
      await invoke(driver, runId, 'checkpoint_playlist_page', virtualStartArgs({
        kind: 'terminal',
        reason: 'known-total-reached'
      }, 5), 'variable-height-start')
      await invoke(driver, runId, 'advance_playlist_page', {}, 'variable-height-bridge')
      assert.deepEqual(browser.actions.slice(-3), [
        'scroll:down:half-viewport:moved',
        'scroll:up:half-viewport:moved',
        'scroll:down:quarter-viewport:moved'
      ])
      await invoke(driver, runId, 'advance_playlist_page', {}, 'variable-height-bottom')
      await invoke(driver, runId, 'advance_playlist_page', {}, 'variable-height-probe')
      await invoke(driver, runId, 'advance_playlist_page', {}, 'variable-height-confirm')

      assert.equal(repository.snapshot(runId)?.phase, 'completed')
      assert.equal((database.prepare(
        `SELECT COUNT(*) AS n FROM playlist_import_page_items`
      ).get() as { n: number }).n, 5)
    } finally {
      database.close()
    }
  })

  it('combines virtual scrolling with host-owned load-more and checkpoints the expanded window', async () => {
    const runId = 'run-driver-virtual-load-more'
    const sourceUrl = 'https://example.test/combined'
    const { database, repository, driver } = fixture(runId, sourceUrl)
    const browser = new ScriptedVirtualBrowser(
      sourceUrl,
      [
        {
          positions: [0, 1],
          scrollTop: 0,
          scrollHeight: 400,
          clientHeight: 200,
          atEnd: false,
          loadMoreAvailable: true
        },
        {
          positions: [0, 1],
          scrollTop: 200,
          scrollHeight: 400,
          clientHeight: 200,
          atEnd: true,
          loadMoreAvailable: true
        }
      ],
      [{
        positions: [2, 3],
        scrollTop: 0,
        scrollHeight: 800,
        clientHeight: 200,
        atEnd: false,
        loadMoreAvailable: false
      }]
    )
    installScriptedDependencies(driver, repository, browser)
    try {
      await invoke(driver, runId, 'checkpoint_playlist_page', virtualStartArgs({
        kind: 'load-more',
        selector: '#load-more',
        afterExhausted: { kind: 'terminal', reason: 'load-more-control-exhausted' }
      }), 'checkpoint-combined')
      await invoke(driver, runId, 'advance_playlist_page', {}, 'scroll-bottom')
      await invoke(driver, runId, 'advance_playlist_page', {}, 'probe-bottom')
      await invoke(driver, runId, 'advance_playlist_page', {}, 'confirm-bottom')
      await invoke(driver, runId, 'advance_playlist_page', {}, 'click-load-more')

      const dynamic = repository.openDynamicPage(runId)
      assert.ok(dynamic)
      assert.deepEqual(dynamic.occurrences.map((item) => item.position), [0, 1, 2, 3])
      assert.equal(dynamic.batches.at(-1)?.operationKey.startsWith('virtual-load-more:'), true)
      assert.equal(browser.actions.includes('click:load-more'), true)
      const latest = database.prepare(
        `SELECT view_revision, evidence_ref FROM playlist_import_scroll_batches
         ORDER BY batch_order DESC LIMIT 1`
      ).get() as { view_revision: string; evidence_ref: string }
      assert.equal(latest.evidence_ref, browser.evidenceByRevision.get(latest.view_revision))
    } finally {
      database.close()
    }
  })

  it('replays only committed virtual prefixes across both crash windows before continuing', async () => {
    const runId = 'run-driver-recovery'
    const sourceUrl = 'https://example.test/recovery'
    const { database, repository, driver } = fixture(runId, sourceUrl)
    const beforeCrash = new ScriptedVirtualBrowser(sourceUrl, [
      { positions: [0, 1], scrollTop: 0, scrollHeight: 800, clientHeight: 200, atEnd: false },
      { positions: [1, 2], scrollTop: 300, scrollHeight: 800, clientHeight: 200, atEnd: false },
      { positions: [2, 3], scrollTop: 600, scrollHeight: 800, clientHeight: 200, atEnd: true }
    ])
    installScriptedDependencies(driver, repository, beforeCrash)
    try {
      await invoke(driver, runId, 'checkpoint_playlist_page', virtualStartArgs({
        kind: 'terminal',
        reason: 'known-total-reached'
      }, 4), 'recovery-start')
      await invoke(driver, runId, 'advance_playlist_page', {}, 'committed-response-lost')
      // Simulate a second scroll that changed the DOM but crashed before its checkpoint.
      await beforeCrash.hostAction({ command: { action: 'scroll', direction: 'down' } })
      assert.deepEqual(repository.openDynamicPage(runId)?.occurrences.map((item) => item.position), [0, 1, 2])

      const recoveredBrowser = new ScriptedVirtualBrowser(sourceUrl, [
        { positions: [0, 1], scrollTop: 0, scrollHeight: 800, clientHeight: 200, atEnd: false },
        { positions: [1, 2], scrollTop: 300, scrollHeight: 800, clientHeight: 200, atEnd: false },
        { positions: [2, 3], scrollTop: 600, scrollHeight: 800, clientHeight: 200, atEnd: true }
      ])
      installScriptedDependencies(driver, repository, recoveredBrowser)
      await driver.replayDynamicPage(
        runId,
        repository.openDynamicPage(runId)!,
        new AbortController().signal
      )
      assert.deepEqual(recoveredBrowser.actions.slice(0, 2), ['scroll:start', 'scroll:down:moved'])

      await invoke(driver, runId, 'advance_playlist_page', {}, 'continue-after-recovery')
      assert.deepEqual(repository.openDynamicPage(runId)?.occurrences.map((item) => item.position), [0, 1, 2, 3])
      assert.equal((database.prepare(
        `SELECT COUNT(*) AS value FROM playlist_import_page_items`
      ).get() as { value: number }).value, 4)
    } finally {
      database.close()
    }
  })

  it('retries a stalled virtual window once, then fails when it still cannot progress', async () => {
    const runId = 'run-driver-scroll-stalled'
    const sourceUrl = 'https://example.test/stalled'
    const { database, repository, driver } = fixture(runId, sourceUrl)
    const browser = new ScriptedVirtualBrowser(sourceUrl, [{
      positions: [0, 1],
      scrollTop: 0,
      scrollHeight: 800,
      clientHeight: 200,
      atEnd: false
    }])
    installScriptedDependencies(driver, repository, browser)
    try {
      await invoke(driver, runId, 'checkpoint_playlist_page', virtualStartArgs({
        kind: 'terminal',
        reason: 'known-total-reached'
      }, 3), 'stalled-start')
      await invoke(driver, runId, 'advance_playlist_page', {}, 'stalled-advance')

      const retryable = repository.snapshot(runId)!
      assert.equal(retryable.phase, 'discovering-list')
      assert.equal(retryable.error?.code, 'SCROLL_STALLED')
      assert.equal(retryable.error?.retryable, true)

      await invoke(driver, runId, 'advance_playlist_page', {}, 'stalled-retry')

      const failed = repository.snapshot(runId)!
      assert.equal(failed.phase, 'failed')
      assert.equal(failed.error?.code, 'SCROLL_LOOP')
      assert.equal(failed.error?.retryable, false)
      assert.equal(browser.actions.filter((action) => action.startsWith('scroll:down')).length, 2)
    } finally {
      database.close()
    }
  })

  it('keeps startup recovery transient failures recoverable at their durable checkpoint', async () => {
    const cases = [
      { suffix: 'timeout', error: new Error('工具执行超时'), code: 'NETWORK_TIMEOUT' },
      {
        suffix: 'session',
        error: new Error('Agent 元数据浏览器会话不存在。'),
        code: 'BROWSER_SESSION_LOST'
      },
      {
        suffix: 'source',
        error: new Error('SOURCE_CHANGED:VIRTUAL_PREFIX'),
        code: 'SOURCE_CHANGED'
      }
    ] as const

    for (const entry of cases) {
      const runId = `run-driver-recovery-${entry.suffix}`
      const sourceUrl = `https://example.test/${entry.suffix}`
      const { database, repository, driver } = fixture(runId, sourceUrl)
      const browser = new ScriptedVirtualBrowser(sourceUrl, [{
        positions: [0],
        scrollTop: 0,
        scrollHeight: 400,
        clientHeight: 200,
        atEnd: false
      }])
      installScriptedDependencies(driver, repository, browser)
      let shouldFail = true
      let recoveryDispatches = 0
      Object.defineProperty(driver as unknown as Record<string, unknown>, 'restoreRun', {
        value: async () => {
          if (shouldFail) throw entry.error
          return repository.snapshot(runId)!
        },
        configurable: true
      })
      Object.defineProperty(driver as unknown as Record<string, unknown>, 'dispatchRecovery', {
        value: async () => { recoveryDispatches += 1 },
        configurable: true
      })
      const released: string[] = []
      const closed: string[] = []
      const restoreRelease = replaceMethod(agentExecution, 'releaseRun', (async (id) => {
        released.push(id)
      }) as typeof agentExecution.releaseRun)
      const restoreClose = replaceMethod(agentExecution, 'closeRun', (async (id) => {
        closed.push(id)
      }) as typeof agentExecution.closeRun)
      try {
        await driver.recoverPending()
        const recovered = repository.snapshot(runId)!
        assert.equal(recovered.phase, 'discovering-list')
        assert.equal(recovered.error?.code, entry.code)
        assert.equal(recovered.error?.retryable, true)
        assert.deepEqual(released, [runId])
        assert.deepEqual(closed, [])

        shouldFail = false
        await driver.recover(runId)
        const resumed = repository.snapshot(runId)!
        assert.equal(resumed.phase, 'discovering-list')
        assert.equal(resumed.error, undefined)
        assert.equal(recoveryDispatches, 1)
      } finally {
        restoreClose()
        restoreRelease()
        database.close()
      }
    }
  })
})

describe('playlistImportRecoverableToolFailure', () => {
  it('classifies timeout, lost-session, and changed-source failures without masking other errors', () => {
    const timeout = new AbortController()
    timeout.abort(new Error('工具执行超时'))
    assert.equal(
      playlistImportRecoverableToolFailure(new Error('AbortError'), timeout.signal)?.code,
      'NETWORK_TIMEOUT'
    )
    assert.equal(
      playlistImportRecoverableToolFailure(new Error('Agent 元数据浏览器会话不存在。'))?.code,
      'BROWSER_SESSION_LOST'
    )
    assert.equal(
      playlistImportRecoverableToolFailure(new Error('SOURCE_CHANGED:VIRTUAL_PREFIX'))?.code,
      'SOURCE_CHANGED'
    )
    assert.equal(
      playlistImportRecoverableToolFailure(new Error('Scrape browser IPC is closed'))?.code,
      'BROWSER_SESSION_LOST'
    )
    assert.equal(
      playlistImportRecoverableToolFailure(new Error('Scraper helper CDP disconnected'))?.code,
      'BROWSER_SESSION_LOST'
    )
    assert.equal(playlistImportRecoverableToolFailure(new Error('invalid selector')), null)
  })
})
