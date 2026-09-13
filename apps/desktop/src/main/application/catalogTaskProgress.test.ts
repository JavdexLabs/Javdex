import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { CatalogTaskSnapshot } from '@shared/protocol/tasks'
import type { CatalogBackend } from './catalogBackend'
import {
  decideCatalogTaskProgressApply,
  isTerminalCatalogTaskState,
  waitForCatalogTask
} from './catalogTaskProgress'

function snapshot(patch: Partial<CatalogTaskSnapshot>): CatalogTaskSnapshot {
  return {
    owner: 'catalog',
    taskId: 'task-1',
    catalogId: 'catalog-a',
    kind: 'scan',
    state: 'running',
    taskRevision: 1,
    progressSeq: 0,
    ...patch
  }
}

describe('catalogTaskProgress', () => {
  it('rejects a late response from a previous connection generation', () => {
    assert.deepEqual(
      decideCatalogTaskProgressApply({
        current: null,
        incoming: snapshot({ state: 'succeeded', taskRevision: 4 }),
        requestGeneration: 1,
        currentGeneration: 2
      }),
      { apply: false, reason: 'stale-generation' }
    )
  })

  it('rejects a snapshot from another catalog identity', () => {
    assert.deepEqual(
      decideCatalogTaskProgressApply({
        current: snapshot({ state: 'running' }),
        incoming: snapshot({ catalogId: 'catalog-b', taskRevision: 2 }),
        requestGeneration: 1,
        currentGeneration: 1,
        expectedCatalogId: 'catalog-a'
      }),
      { apply: false, reason: 'catalog-mismatch' }
    )
  })

  it('does not rewind a terminal task when a late running poll arrives', () => {
    assert.equal(isTerminalCatalogTaskState('succeeded'), true)
    assert.deepEqual(
      decideCatalogTaskProgressApply({
        current: snapshot({ state: 'succeeded', taskRevision: 5, progressSeq: 4 }),
        incoming: snapshot({ state: 'running', taskRevision: 6, progressSeq: 5 }),
        requestGeneration: 2,
        currentGeneration: 2,
        expectedTaskId: 'task-1'
      }),
      { apply: false, reason: 'terminal-rewind' }
    )
  })

  it('does not apply an older taskRevision or progressSeq', () => {
    const current = snapshot({ taskRevision: 4, progressSeq: 7 })
    assert.deepEqual(
      decideCatalogTaskProgressApply({
        current,
        incoming: snapshot({ taskRevision: 3, progressSeq: 9 }),
        requestGeneration: 1,
        currentGeneration: 1
      }),
      { apply: false, reason: 'stale-revision' }
    )
    assert.deepEqual(
      decideCatalogTaskProgressApply({
        current,
        incoming: snapshot({ taskRevision: 4, progressSeq: 6 }),
        requestGeneration: 1,
        currentGeneration: 1
      }),
      { apply: false, reason: 'stale-progress' }
    )
  })

  it('waits for a later terminal snapshot and ignores a late older running poll', async () => {
    const polls: CatalogTaskSnapshot[] = [
      snapshot({ state: 'running', taskRevision: 2, progressSeq: 1, counts: { scanned: 1 } }),
      snapshot({ state: 'running', taskRevision: 1, progressSeq: 0, counts: { scanned: 0 } }),
      snapshot({
        state: 'succeeded',
        taskRevision: 3,
        progressSeq: 2,
        counts: { scanned: 4, imported: 1 }
      })
    ]
    const applied: CatalogTaskSnapshot[] = []
    const backend = {
      generation: 4,
      session: () => ({ catalogId: 'catalog-a' }),
      tasks: {
        get: async () => {
          const next = polls.shift()
          if (!next) throw new Error('extra poll')
          return next
        }
      }
    } as unknown as Pick<CatalogBackend, 'tasks' | 'generation' | 'session'>
    const result = await waitForCatalogTask({
      backend,
      taskId: 'task-1',
      intervalMs: 1,
      sleep: async () => undefined,
      onApplied: (snapshot) => applied.push(snapshot)
    })
    assert.equal(result.state, 'succeeded')
    assert.equal(result.taskRevision, 3)
    assert.deepEqual(
      applied.map((item) => item.taskRevision),
      [2, 3]
    )
    assert.equal(polls.length, 0)
  })

  it('discards a completed snapshot that arrived after reconnect generation advanced', async () => {
    let generation = 1
    let calls = 0
    const applied: number[] = []
    const backend = {
      get generation() {
        return generation
      },
      session: () => ({ catalogId: 'catalog-a' }),
      tasks: {
        get: async () => {
          calls += 1
          if (calls === 1) {
            generation = 2
            return snapshot({ state: 'succeeded', taskRevision: 8, progressSeq: 3 })
          }
          return snapshot({
            state: 'succeeded',
            taskRevision: 9,
            progressSeq: 4,
            counts: { scanned: 2 }
          })
        }
      }
    } as unknown as Pick<CatalogBackend, 'tasks' | 'generation' | 'session'>
    const result = await waitForCatalogTask({
      backend,
      taskId: 'task-1',
      intervalMs: 1,
      sleep: async () => undefined,
      onApplied: (item) => applied.push(item.taskRevision)
    })
    assert.equal(result.taskRevision, 9)
    assert.deepEqual(applied, [9])
  })

  it('stops waiting when the caller aborts without applying a later snapshot', async () => {
    const abort = new AbortController()
    let calls = 0
    const backend = {
      generation: 1,
      session: () => ({ catalogId: 'catalog-a' }),
      tasks: {
        get: async () => {
          calls += 1
          abort.abort()
          return snapshot({ state: 'running', taskRevision: 1, progressSeq: 0 })
        }
      }
    } as unknown as Pick<CatalogBackend, 'tasks' | 'generation' | 'session'>
    await assert.rejects(
      () =>
        waitForCatalogTask({
          backend,
          taskId: 'task-1',
          intervalMs: 1,
          sleep: async () => undefined,
          signal: abort.signal
        }),
      /任务已取消/
    )
    assert.equal(calls, 1)
  })

  it('aborts an in-flight tasks.get poll without waiting for a later snapshot', async () => {
    const abort = new AbortController()
    const backend = {
      generation: 1,
      session: () => ({ catalogId: 'catalog-a' }),
      tasks: {
        get: async () => new Promise<CatalogTaskSnapshot>(() => undefined)
      }
    } as unknown as Pick<CatalogBackend, 'tasks' | 'generation' | 'session'>
    const pending = waitForCatalogTask({
      backend,
      taskId: 'task-1',
      intervalMs: 1,
      sleep: async () => undefined,
      signal: abort.signal
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    abort.abort()
    await assert.rejects(() => pending, /任务已取消/)
  })
})
