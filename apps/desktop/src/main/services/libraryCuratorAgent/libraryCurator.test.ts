import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { agentExecution } from '../../agent-platform/agentExecution'
import { toolHost } from '../../agent-platform/toolHost'
import { LibraryCurator } from './libraryCurator'

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

describe('LibraryCurator lifecycle', { concurrency: false }, () => {
  it('releases its own runs without disposing the application AgentExecution', async () => {
    const curator = new LibraryCurator()
    const active = (curator as unknown as { active: Map<string, unknown> }).active
    active.set('curator-owned-run', {})
    const released: string[] = []
    const disposedTools: string[] = []
    let globalDisposeCalls = 0
    const restoreToolDispose = replaceMethod(
      toolHost,
      'disposeRun',
      ((runId) => { disposedTools.push(runId) }) as typeof toolHost.disposeRun
    )
    const restoreRelease = replaceMethod(
      agentExecution,
      'releaseRun',
      (async (runId) => { released.push(runId) }) as typeof agentExecution.releaseRun
    )
    const restoreGlobalDispose = replaceMethod(
      agentExecution,
      'dispose',
      (async () => { globalDisposeCalls += 1 }) as typeof agentExecution.dispose
    )
    try {
      await curator.dispose()

      assert.deepEqual(disposedTools, ['curator-owned-run'])
      assert.deepEqual(released, ['curator-owned-run'])
      assert.equal(globalDisposeCalls, 0)
      assert.equal(active.size, 0)
    } finally {
      restoreGlobalDispose()
      restoreRelease()
      restoreToolDispose()
    }
  })
})

it('uses the indexed journal cursor for a curator snapshot', async (t) => {
  const { agentRunStore } = await import('../../agent-platform/agentRunStore')
  const curator = new LibraryCurator()
  const active = (curator as unknown as { active: Map<string, unknown> }).active
  active.set('cursor-run', { state: { status: 'waiting_user', summary: 'waiting', totalTokens: 17 } })
  const cursor = t.mock.method(agentRunStore, 'getProductJournalCursor', () => 23456)
  t.mock.method(agentRunStore, 'readProductJournal', () => { throw new Error('snapshot must not load the journal') })
  try {
    assert.deepEqual(curator.getSnapshot('cursor-run'), {
      runId: 'cursor-run', status: 'waiting_user', summary: 'waiting', totalTokens: 17, cursor: 23456
    })
    assert.equal(cursor.mock.callCount(), 1)
    assert.equal(cursor.mock.calls[0].arguments[0], 'cursor-run')
  } finally { t.mock.restoreAll() }
})
