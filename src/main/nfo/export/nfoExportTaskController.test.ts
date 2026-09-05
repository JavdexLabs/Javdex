import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { NfoExportPlanRequest, NfoExportReport } from '@shared/nfoExportTypes'
import type { InternalNfoExportPlan } from './nfoExportModule'
import { NfoExportTaskController } from './nfoExportTaskController'

const request: NfoExportPlanRequest = {
  libraryIds: [1], profileId: 'portable-v1', includeCover: true, includeFanart: true,
  includeSamples: false, includeActorAvatars: false, collisionPolicy: 'skip'
}

function emptyPlan(): InternalNfoExportPlan {
  return {
    createdAt: '2026-09-05T00:00:00Z',
    files: [],
    preview: {
      planId: '00000000-0000-4000-8000-000000000001',
      request,
      files: [], warnings: [],
      summary: {
        videoCount: 0, resourceCount: 0, fileCount: 0, createCount: 0, replaceCount: 0,
        skipCount: 0, conflictCount: 0, unavailableCount: 0, skippedNoAnchorCount: 0,
        warningCount: 0, sampleCount: 0, estimatedBytes: 0
      }
    }
  }
}

describe('NfoExportTaskController', async () => {
  it('keeps planning leases until an asynchronous plan settles, including disposal and failures', async () => {
    const releases: string[] = []
    let finish!: (plan: InternalNfoExportPlan) => void
    const controller = new NfoExportTaskController(
      { plan: () => new Promise((resolve) => { finish = resolve }), apply: async () => { throw new Error('unused') } },
      { tryAcquire: () => ({ kind: 'nfo-export', release: () => releases.push('gate') }) },
      { acquireStableReadLease: () => ({ release: () => releases.push('assets') }) }
    )
    const pending = controller.plan(request)
    assert.equal(controller.hasActivePlanOrTask, true)
    await assert.rejects(controller.plan(request), /正在生成预览/u)
    const disposed = controller.dispose()
    assert.deepEqual([...releases], [])
    finish(emptyPlan())
    await pending
    await disposed
    assert.deepEqual([...releases].sort(), ['assets', 'gate'])
    assert.equal(controller.hasActivePlanOrTask, false)

    const failing = new NfoExportTaskController(
      { plan: async () => { throw new Error('planning failed') }, apply: async () => { throw new Error('unused') } },
      { tryAcquire: () => ({ kind: 'nfo-export', release: () => releases.push('gate') }) },
      { acquireStableReadLease: () => ({ release: () => releases.push('assets') }) }
    )
    await assert.rejects(failing.plan(request), /planning failed/u)
    assert.equal(releases.length, 4)
  })

  it('holds both leases from plan through apply and releases them at terminal state', async () => {
    const releases: string[] = []
    let finish!: (report: NfoExportReport) => void
    const module = {
      plan: async () => emptyPlan(),
      apply: () => new Promise<NfoExportReport>((resolve) => { finish = resolve })
    }
    const controller = new NfoExportTaskController(
      module,
      { tryAcquire: () => ({ kind: 'nfo-export', release: () => releases.push('gate') }) },
      { acquireStableReadLease: () => ({ release: () => releases.push('assets') }) }
    )
    const preview = await controller.plan(request)
    assert.deepEqual(releases, [])
    assert.equal(controller.hasActivePlanOrTask, true)
    assert.equal(controller.isForegroundBlocking, false)
    const started = controller.start(preview.planId)
    assert.equal(controller.isForegroundBlocking, true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(releases, [])
    finish({
      taskId: started.taskId, startedAt: '', finishedAt: '', terminated: false,
      writtenCount: 0, skippedCount: 0, failedCount: 0, items: []
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(releases.sort(), ['assets', 'gate'])
  })

  it('releases leases when a plan is discarded or planning fails', async () => {
    const releases: string[] = []
    const lease = (name: string) => ({ release: () => releases.push(name) })
    const controller = new NfoExportTaskController(
      { plan: async () => emptyPlan(), apply: async () => { throw new Error('unused') } },
      { tryAcquire: () => ({ kind: 'nfo-export', ...lease('gate') }) },
      { acquireStableReadLease: () => lease('assets') }
    )
    controller.discardPlan((await controller.plan(request)).planId)
    assert.deepEqual(releases.sort(), ['assets', 'gate'])
  })

  it('requests termination and waits for apply before process disposal releases leases', async () => {
    const releases: string[] = []
    const controller = new NfoExportTaskController(
      {
        plan: async () => emptyPlan(),
        apply: async (_plan, taskId, signal) => {
          while (!signal.isTerminated()) await new Promise<void>((resolve) => setImmediate(resolve))
          return {
            taskId, startedAt: '', finishedAt: '', terminated: true,
            writtenCount: 0, skippedCount: 0, failedCount: 0, items: []
          }
        }
      },
      { tryAcquire: () => ({ kind: 'nfo-export', release: () => releases.push('gate') }) },
      { acquireStableReadLease: () => ({ release: () => releases.push('assets') }) }
    )
    const plan = await controller.plan(request)
    controller.start(plan.planId)
    await controller.dispose()
    assert.deepEqual(releases.sort(), ['assets', 'gate'])
  })

  it('does not acquire an asset lease when another maintenance task owns the gate', async () => {
    let assetLeases = 0
    const controller = new NfoExportTaskController(
      { plan: async () => emptyPlan(), apply: async () => { throw new Error('unused') } },
      { tryAcquire: () => null },
      { acquireStableReadLease: () => { assetLeases += 1; return { release: () => undefined } } }
    )
    await assert.rejects(() => controller.plan(request), /已有扫描或资源维护任务/u)
    assert.equal(assetLeases, 0)
  })
})
