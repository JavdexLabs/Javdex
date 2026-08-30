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
