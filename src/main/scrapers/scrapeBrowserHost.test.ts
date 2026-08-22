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
}

function actionHost(input: {
  click?: (helper: { pageEpoch: number }) => Promise<void>
  evaluate?: (expression: string) => Promise<unknown>
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
    waitFor: async () => undefined
  }
  const helperRecord = {
    generation: 7,
    fatal: false,
    pageEpoch: 1,
    snapshotEpoch: 1,
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

function fakeHost(idleTimeoutMs = 10): {
  host: ScrapeBrowserHostModule
  calls: Array<{ command: string; payload: Record<string, unknown> }>
  stops: string[]
} {
  const host = new ScrapeBrowserHostModule(idleTimeoutMs)
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
    await first.release()
    await second.fetchPage('https://example.com')
    await second.release()
  })

  it('freezes proxy and stops the helper after the idle timeout', async () => {
    const { host, stops } = fakeHost(5)
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
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(stops, ['idle timeout'])
  })

  it('presents the helper through the lease without exposing it as a plugin browser action', async () => {
    const { host, calls } = fakeHost()
    const lease = await host.acquire({
      ownerId: 'agent',
      purpose: 'agent-browser',
      signal: new AbortController().signal
    })

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
      snapshotEpoch: null,
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
      /必须唯一匹配/
    )
  })
})
