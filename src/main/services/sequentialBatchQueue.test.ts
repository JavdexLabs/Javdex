import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SequentialBatchQueue } from './sequentialBatchQueue'
import type { BatchProgress } from '@shared/types'

describe('SequentialBatchQueue', () => {
  it('counts success, pending, and failure as disjoint processed outcomes', async () => {
    const queue = new SequentialBatchQueue<{ code: string }>()
    const outcomes = new Map<string, 'success' | 'pending' | 'failure'>([
      ['A', 'success'],
      ['B', 'pending'],
      ['C', 'failure']
    ])

    const result = await queue.start({
      targets: [{ code: 'A' }, { code: 'B' }, { code: 'C' }],
      startMessage: () => 'start',
      pausedMessage: 'paused',
      cancelledMessage: 'cancelled',
      doneMessage: () => 'done',
      getCode: (target) => target.code,
      runTarget: async (target) => ({
        status: outcomes.get(target.code)!,
        level: 'info',
        message: target.code
      }),
      exceptionMessage: () => 'error',
      delayAfterTarget: false
    })

    assert.equal(result, 'done')
    assert.deepEqual(
      {
        current: queue.getProgress().current,
        success: queue.getProgress().success,
        pending: queue.getProgress().pending,
        failed: queue.getProgress().failed
      },
      { current: 3, success: 1, pending: 1, failed: 1 }
    )
  })

  it('pauses after the current target and resumes from checkpoint', async () => {
    const queue = new SequentialBatchQueue<{ id: number; code: string }>()
    const processed: string[] = []
    const checkpoints: number[] = []

    const run = {
      targets: [
        { id: 1, code: 'A' },
        { id: 2, code: 'B' },
        { id: 3, code: 'C' }
      ],
      startMessage: (total: number) => `start ${total}`,
      pausedMessage: 'paused',
      cancelledMessage: 'cancelled',
      doneMessage: () => 'done',
      getCode: (target: { code: string }) => target.code,
      runTarget: async (target: { code: string }) => {
        processed.push(target.code)
        if (target.code === 'A') queue.pause()
        return { status: 'success' as const, level: 'success' as const, message: 'ok' }
      },
      exceptionMessage: () => 'error',
      delayAfterTarget: false,
      onCheckpoint: (_progress: BatchProgress, nextIndex: number) => {
        checkpoints.push(nextIndex)
      }
    }

    const firstOutcome = await queue.start(run)
    assert.equal(firstOutcome, 'paused')
    assert.deepEqual(processed, ['A'])
    assert.equal(queue.getProgress().status, 'paused')
    assert.equal(queue.getProgress().current, 1)

    const resumeOutcome = await queue.start({
      ...run,
      startIndex: 1,
      initialProgress: {
        success: queue.getProgress().success,
        pending: queue.getProgress().pending,
        failed: queue.getProgress().failed,
        logs: queue.getProgress().logs
      },
      runTarget: async (target: { code: string }) => {
        processed.push(target.code)
        return { status: 'success' as const, level: 'success' as const, message: 'ok' }
      }
    })

    assert.equal(resumeOutcome, 'done')
    assert.deepEqual(processed, ['A', 'B', 'C'])
    assert.equal(queue.getProgress().status, 'done')
    assert.ok(checkpoints.includes(1))
  })
})
