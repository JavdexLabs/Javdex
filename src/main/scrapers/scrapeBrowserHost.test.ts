import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ScrapeBrowserActionUncertainError,
  ScrapeBrowserBusyError,
  ScrapeBrowserHostModule,
  ScrapeBrowserObservationPendingError,
  type AgentBrowserCommand,
  type AgentBrowserObservation
} from './scrapeBrowser'
import type {
  ScrapeBrowserListExtraction,
  ScrapeBrowserListExtractionPlan
} from './scrapeBrowserTypes'

interface TestHostInternals {
  helper: { generation: number } | null
  ensureHelper: (signal: AbortSignal) => Promise<{ generation: number }>
  request: (
    command: string,
    payload: Record<string, unknown>,
    signal: AbortSignal
  ) => Promise<unknown>
  stopHelper: (reason: string) => Promise<void>
  runAgentAction?: () => Promise<never>
}

interface RequestTestInternals {
  helper: {
    generation: number
    fatal: boolean
    framed: { send: (frame: Record<string, unknown>) => void }
  } | null
  request: (
    command: 'performAction',
    payload: Record<string, unknown>,
    signal: AbortSignal
  ) => Promise<unknown>
  handleFrame: (frame: {
    type: 'response'
    id: string
    ok: boolean
    value?: unknown
  }) => void
  stopHelper: (reason: string) => Promise<void>
}

interface ActionTestInternals {
  helper: Record<string, unknown> | null
  snapshot: (
    helper: Record<string, unknown>,
    command: Extract<AgentBrowserCommand, { action: 'snapshot' }>,
    signal: AbortSignal,
    timeoutMs?: number
  ) => Promise<AgentBrowserObservation>
  runAgentAction: (
    command: AgentBrowserCommand,
    signal: AbortSignal
  ) => Promise<AgentBrowserObservation>
  extractList: (
    plan: ScrapeBrowserListExtractionPlan,
    signal: AbortSignal
  ) => Promise<ScrapeBrowserListExtraction>
}

function actionHost(input: {
  click?: (helper: { pageEpoch: number }) => Promise<void>
  evaluate?: (expression: string) => Promise<unknown>
  scrollEvaluate?: () => Promise<unknown>
  count?: number
  snapshot: () => Promise<AgentBrowserObservation>
}): { host: ScrapeBrowserHostModule; internals: ActionTestInternals } {
  const host = new ScrapeBrowserHostModule()
  const internals = host as unknown as ActionTestInternals
  const body = {
    count: async () => 1,
    waitFor: async () => undefined,
    ariaSnapshot: async () => '- document'
  }
  const target = {
    count: async () => input.count ?? 1,
    click: async () => input.click?.(helperRecord),
    fill: async () => undefined,
    press: async () => undefined,
    waitFor: async () => undefined,
    evaluate: async () => input.scrollEvaluate?.()
  }
  const helperRecord = {
    generation: 7,
    fatal: false,
    pageEpoch: 1,
    viewEpoch: 0,
    snapshotViewRevision: '7:1:0',
    page: {
      locator: (selector: string) => selector === 'body' ? body : target,
      url: () => 'https://example.test/detail',
      title: async () => 'detail',
      evaluate: async (expression: string) => input.evaluate?.(expression),
      waitForLoadState: async () => undefined,
      waitForTimeout: async () => undefined,
      keyboard: { press: async () => undefined }
    }
  } as unknown as { pageEpoch: number }
  internals.helper = helperRecord
  internals.snapshot = async () => input.snapshot()
  return { host, internals }
}

function fakeHost(): {
  host: ScrapeBrowserHostModule
  calls: Array<{ command: string; payload: Record<string, unknown> }>
  stops: string[]
} {
  const host = new ScrapeBrowserHostModule()
  const calls: Array<{ command: string; payload: Record<string, unknown> }> = []
  const stops: string[] = []
  const internals = host as unknown as TestHostInternals
  const helper = { generation: 1 }
  internals.helper = helper
  internals.ensureHelper = async (signal) => {
    signal.throwIfAborted()
    internals.helper = helper
    return helper
  }
  internals.request = async (command, payload, signal) => {
    signal.throwIfAborted()
    calls.push({ command, payload })
    return command === 'fetchBuffer' ? Buffer.from('ok') : true
  }
  internals.stopHelper = async (reason) => {
    if (!internals.helper) return
    stops.push(reason)
    internals.helper = null
  }
  return { host, calls, stops }
}

describe('ScrapeBrowserHost leases', () => {
  it('reuses the same owner and rejects a competing owner immediately', async () => {
    const { host, calls } = fakeHost()
    const signal = new AbortController().signal
    const first = await host.acquire({
      ownerId: 'owner-a',
      purpose: 'scrape',
      proxyUrl: 'http://proxy.example:8080',
      signal
    })
    const second = await host.acquire({
      ownerId: 'owner-a',
      purpose: 'scrape',
      proxyUrl: 'http://proxy.example:8080',
      signal
    })
    await assert.rejects(
      host.acquire({ ownerId: 'owner-b', purpose: 'plugin-check', signal }),
      (error) => error instanceof ScrapeBrowserBusyError && error.ownerId === 'owner-a'
    )
    assert.equal(calls.filter((call) => call.command === 'setProxy').length, 1)
    assert.equal(
      calls.filter((call) =>
        call.command === 'performAction' && call.payload.action === 'present'
      ).length,
      1
    )
    await first.release()
    await second.fetchPage('https://example.com')
    await second.release()
  })

  it('freezes proxy and stops the helper as soon as a scrape lease is released', async () => {
    const { host, stops } = fakeHost()
    const signal = new AbortController().signal
    const lease = await host.acquire({ ownerId: 'owner', purpose: 'scrape', signal })
    await assert.rejects(
      host.acquire({
        ownerId: 'owner',
        purpose: 'scrape',
        proxyUrl: 'http://changed.example:8080',
        signal
      }),
      /不能切换代理/
    )
    await lease.release()
    assert.deepEqual(stops, ['lease released'])
  })

  it('closes the active helper session with the main window and remains reusable', async () => {
    const { host, stops } = fakeHost()
    const activeLease = await host.acquire({
      ownerId: 'window-session',
      purpose: 'scrape',
      signal: new AbortController().signal
    })

    await host.closeSession()

    await assert.rejects(activeLease.fetchPage('https://example.test'), /租约已失效/)
    const reopenedLease = await host.acquire({
      ownerId: 'reopened-window-session',
      purpose: 'scrape',
      signal: new AbortController().signal
    })
    await reopenedLease.release()
    assert.deepEqual(stops, ['host session closed', 'lease released'])
  })

  it('presents the helper through the lease without exposing it as a plugin browser action', async () => {
    const { host, calls } = fakeHost()
    const lease = await host.acquire({
      ownerId: 'agent',
      purpose: 'agent-browser',
      signal: new AbortController().signal
    })
    assert.equal(
      calls.filter((call) =>
        call.command === 'performAction' && call.payload.action === 'present'
      ).length,
      0
    )

    assert.deepEqual(await lease.presentToUser(), { url: '', title: '' })
    assert.deepEqual(calls.at(-1), {
      command: 'performAction',
      payload: { action: 'present', params: {} }
    })
    await lease.release()
  })

  it('invalidates all lease actions when its operation signal is cancelled', async () => {
    const { host } = fakeHost()
    const controller = new AbortController()
    const lease = await host.acquire({
      ownerId: 'owner',
      purpose: 'agent-browser',
      signal: controller.signal
    })
    controller.abort(new Error('cancelled'))
    await assert.rejects(lease.pluginAction('status'), /cancelled/)
    await lease.release()
  })

  it('terminates the helper when an in-flight Playwright action is cancelled', async () => {
    const { host, stops } = fakeHost()
    const internals = host as unknown as TestHostInternals
    internals.runAgentAction = async () => new Promise<never>(() => undefined)
    const controller = new AbortController()
    const lease = await host.acquire({
      ownerId: 'owner',
      purpose: 'agent-browser',
      signal: controller.signal
    })
    const action = lease.agentAction({ action: 'wait', timeoutMs: 10_000 })
    controller.abort(new Error('playwright cancelled'))
    await assert.rejects(action, /playwright cancelled/)
    assert.deepEqual(stops, ['agent action aborted'])
    await lease.release()
  })

  it('terminates the helper before reporting an evaluate timeout', async () => {
    const { internals } = actionHost({
      evaluate: async () => new Promise<never>(() => undefined),
      snapshot: async () => ({ action: 'snapshot', snapshot: '- document' })
    })
    const stops: string[] = []
    ;(internals as unknown as TestHostInternals).stopHelper = async (reason) => {
      stops.push(reason)
      internals.helper = null
    }

    await assert.rejects(
      internals.runAgentAction({ action: 'evaluate', expression: '() => document.title', timeoutMs: 500 }, new AbortController().signal),
      /evaluate timed out/
    )
    assert.deepEqual(stops, ['agent evaluate timeout'])
  })

  it('keeps oversized ARIA complete for the artifact layer', async () => {
    const host = new ScrapeBrowserHostModule()
    const internals = host as unknown as ActionTestInternals & TestHostInternals
    const raw = `- document\n  - text: ${'field '.repeat(190_000)}`
    const helper = {
      generation: 3,
      fatal: false,
      pageEpoch: 2,
      viewEpoch: 0,
      snapshotViewRevision: null,
      page: {
        locator: () => ({
          count: async () => 1,
          ariaSnapshot: async () => raw
        }),
        title: async () => 'large page',
        url: () => 'https://example.test/large'
      }
    }
    internals.helper = helper
    internals.request = async () => ({ labeledRows: [] })

    const observation = await internals.snapshot(
      helper,
      { action: 'snapshot' },
      new AbortController().signal
    )

    assert.equal(observation.fullSnapshot, raw)
    assert.equal(observation.fullSnapshotTruncated, false)
    assert.equal(observation.evidenceIncomplete, false)
  })

  it('sends cancel, ignores a late response and kills a non-cooperative helper after 500ms', async () => {
    const host = new ScrapeBrowserHostModule()
    const internals = host as unknown as RequestTestInternals
    const sent: Array<Record<string, unknown>> = []
    const stops: string[] = []
    internals.helper = {
      generation: 1,
      fatal: false,
      framed: { send: (frame) => sent.push(frame) }
    }
    internals.stopHelper = async (reason) => { stops.push(reason) }

    const firstController = new AbortController()
    const first = internals.request('performAction', {}, firstController.signal)
    firstController.abort(new Error('first cancelled'))
    await assert.rejects(first, /first cancelled/)
    assert.equal(sent.some((frame) => frame.type === 'cancel'), true)
    internals.handleFrame({ type: 'response', id: '1:1', ok: true, value: 'late' })
    await new Promise((resolve) => setTimeout(resolve, 520))
    assert.deepEqual(stops, [])

    const secondController = new AbortController()
    const second = internals.request('performAction', {}, secondController.signal)
    secondController.abort(new Error('second cancelled'))
    await assert.rejects(second, /second cancelled/)
    await new Promise((resolve) => setTimeout(resolve, 520))
    assert.deepEqual(stops, ['cancel grace exceeded'])
  })

  it('keeps one click successful while transient post-action observation recovers', async () => {
    let clicks = 0
    let observations = 0
    const { internals } = actionHost({
      click: async (helper) => {
        clicks += 1
        helper.pageEpoch += 1
      },
      snapshot: async () => {
        observations += 1
        if (observations < 3) throw new Error('Execution context was destroyed by navigation')
        return {
          action: 'snapshot',
          documentRevision: '7:2',
          snapshot: '- heading "detail" [ref=e1]'
        }
      }
    })

    const result = await internals.runAgentAction(
      { action: 'click', target: '#detail' },
      new AbortController().signal
    )

    assert.equal(clicks, 1)
    assert.equal(observations, 3)
    assert.equal(result.action, 'click')
    assert.equal(result.actionSucceeded, true)
    assert.equal(result.staleRefs, true)
    assert.notEqual(result.observationMode, 'pending')
  })

  it('returns bounded scroll metrics and invalidates refs without changing the document revision', async () => {
    const fixture = actionHost({
      scrollEvaluate: async () => ({
        before: { scrollTop: 0, scrollHeight: 2_400, clientHeight: 600 },
        after: { scrollTop: 300, scrollHeight: 2_400, clientHeight: 600 },
        settled: true,
        descriptor: { kind: 'element', tag: 'div', id: 'list', className: '', role: 'list' }
      }),
      snapshot: async () => ({
        action: 'snapshot',
        documentRevision: '7:1',
        viewRevision: '7:1:1',
        snapshot: '- link "item 20" [ref=e1]'
      })
    })

    const result = await fixture.internals.runAgentAction(
      { action: 'scroll', target: '#list', direction: 'down' },
      new AbortController().signal
    )

    assert.equal(result.action, 'scroll')
    assert.equal(result.documentRevision, '7:1')
    assert.equal(result.viewRevision, '7:1:1')
    assert.equal(result.staleRefs, true)
    assert.deepEqual(result.scrollState?.before, {
      scrollTop: 0,
      scrollHeight: 2_400,
      clientHeight: 600
    })
    assert.equal(result.scrollState?.deltaY, 300)
    assert.equal(result.scrollState?.moved, true)
    assert.equal(result.scrollState?.settled, true)
  })

  it('extracts a host-owned load-more availability signal with the candidate snapshot', async () => {
    const fixture = actionHost({
      evaluate: async () => ({
        items: [{ detailUrl: 'https://example.test/video/1', code: 'ABC-001' }],
        nextPageUrls: [],
        loadMoreAvailable: true,
        scrollMetrics: { scrollTop: 0, scrollHeight: 600, clientHeight: 600 },
        descriptor: { kind: 'document' }
      }),
      snapshot: async () => ({ action: 'snapshot', documentRevision: '7:1' })
    })

    const result = await fixture.internals.extractList({
      candidateSelector: '.item',
      detailLinkSelector: 'a',
      loadMoreSelector: '.load-more'
    }, new AbortController().signal)

    assert.equal(result.loadMoreAvailable, true)
    assert.deepEqual(result.items, [
      { detailUrl: 'https://example.test/video/1', code: 'ABC-001' }
    ])
    assert.equal(result.scrollState?.atEnd, true)
    assert.equal(result.containerFingerprint?.length, 16)
  })

  it('returns the host-owned terminal proof result with the candidate snapshot', async () => {
    const fixture = actionHost({
      evaluate: async () => ({
        items: [{ detailUrl: 'https://example.test/video/1' }],
        nextPageUrls: [],
        terminalVerified: true,
        scrollMetrics: { scrollTop: 0, scrollHeight: 600, clientHeight: 600 },
        descriptor: { kind: 'document' }
      }),
      snapshot: async () => ({ action: 'snapshot', documentRevision: '7:1' })
    })

    const result = await fixture.internals.extractList({
      candidateSelector: '.item',
      detailLinkSelector: 'a',
      terminalProof: {
        kind: 'no-pagination-container-after-full-dom-check',
        selector: '.pagination'
      }
    }, new AbortController().signal)

    assert.equal(result.terminalVerified, true)
  })

  it('returns pending after a successful action but makes explicit snapshot pending retryable', async () => {
    let clicks = 0
    const fixture = actionHost({
      click: async (helper) => {
        clicks += 1
        helper.pageEpoch += 1
      },
      snapshot: async () => {
        throw new Error('Execution context was destroyed by navigation')
      }
    })
    const signal = new AbortController().signal
    const clicked = await fixture.internals.runAgentAction(
      { action: 'click', target: '#detail' },
      signal
    )

    assert.equal(clicks, 1)
    assert.equal(clicked.observationMode, 'pending')
    assert.equal(clicked.actionSucceeded, true)
    assert.equal(clicked.staleRefs, true)
    await assert.rejects(
      fixture.internals.runAgentAction({ action: 'snapshot' }, signal),
      (error) => error instanceof ScrapeBrowserObservationPendingError
    )
    assert.equal(clicks, 1)
  })

  it('classifies a failed state action with a changed revision as uncertain without replaying it', async () => {
    let clicks = 0
    const fixture = actionHost({
      click: async (helper) => {
        clicks += 1
        helper.pageEpoch += 1
        throw new Error('navigation interrupted click response')
      },
      snapshot: async () => ({ action: 'snapshot' })
    })

    await assert.rejects(
      fixture.internals.runAgentAction(
        { action: 'click', target: '#detail' },
        new AbortController().signal
      ),
      (error) => error instanceof ScrapeBrowserActionUncertainError
    )
    assert.equal(clicks, 1)
  })

  it('keeps selector uniqueness failures as ordinary action failures', async () => {
    const fixture = actionHost({
      count: 2,
      snapshot: async () => ({ action: 'snapshot' })
    })
    await assert.rejects(
      fixture.internals.runAgentAction(
        { action: 'click', target: '.duplicate' },
        new AbortController().signal
      ),
      /click target 匹配 2 个元素（\.duplicate）/
    )
  })

  it('reports zero matches separately from multiple matches', async () => {
    const fixture = actionHost({
      count: 0,
      snapshot: async () => ({ action: 'snapshot' })
    })
    await assert.rejects(
      fixture.internals.runAgentAction(
        { action: 'html', target: '#search-box' },
        new AbortController().signal
      ),
      /html target 匹配 0 个元素（#search-box）/
    )
  })
})
