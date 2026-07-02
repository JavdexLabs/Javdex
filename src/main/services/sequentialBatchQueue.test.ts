import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SequentialBatchQueue } from './sequentialBatchQueue'
import type { BatchProgress } from '@shared/types'

describe('SequentialBatchQueue', () => {
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
        return { success: true, level: 'success' as const, message: 'ok' }
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
        failed: queue.getProgress().failed,
        logs: queue.getProgress().logs
      },
      runTarget: async (target: { code: string }) => {
        processed.push(target.code)
        return { success: true, level: 'success' as const, message: 'ok' }
      }
    })

    assert.equal(resumeOutcome, 'done')
    assert.deepEqual(processed, ['A', 'B', 'C'])
    assert.equal(queue.getProgress().status, 'done')
    assert.ok(checkpoints.includes(1))
  })
})
