import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ElectronApi } from '../../../preload/index'
import type { ActressAvatarAutoCropTarget } from '@shared/actressAvatarCropTypes'
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it('serializes startup before target loading and releases ownership on empty, failed or unmounted startup', async () => {
  let begin = deferred<string>()
  let targets = deferred<ActressAvatarAutoCropTarget[]>()
  let begins = 0, reads = 0
  const ended: string[] = []
  const processed: number[] = []
  let heldSource: ReturnType<typeof deferred<null>> | null = null
  const fake = {
    actresses: {
      list: () => { throw new Error('Wide list forbidden') },
      avatarCropTargets: () => { throw new Error('Full target list forbidden') },
      getAvatarSourceInfo: async (id: number) => { processed.push(id); return heldSource ? heldSource.promise : null }
    },
    settings: { get: async () => ({}) },
    avatarAutoCropBatch: {
      targets: async (_token: string, afterId: number) => {
        reads++
        const all = await targets.promise
        const remaining = afterId === 0 ? all : all.filter(item => item.actressId > afterId)
        const items = remaining.slice(0,100)
        return {items,total:all.length,nextAfterId:remaining.length>100?items[items.length-1].actressId:null}
      },
      begin: () => { begins++; return begin.promise },
      end: async (token: string) => { ended.push(token); return true }
    },
    actressScrape: { onAvatarAutoCropRequest: () => () => {} }
  } as unknown as ElectronApi
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: fake } })
  const { AvatarAutoCropBatchProvider, useAvatarAutoCropBatch } = await import('./AvatarAutoCropBatchContext')
  let current!: ReturnType<typeof useAvatarAutoCropBatch>
  function Probe() { current = useAvatarAutoCropBatch(); return null }
  const client = new QueryClient()
  let renderer!: TestRenderer.ReactTestRenderer
  const mount = async () => { await act(async () => { renderer = TestRenderer.create(
    <QueryClientProvider client={client}><AvatarAutoCropBatchProvider><Probe /></AvatarAutoCropBatchProvider></QueryClientProvider>
  ) }) }
  const unmount = async () => { await act(async () => renderer.unmount()) }
  try {
    await mount()
    const first = current.startAllAvatars()
    await assert.rejects(current.startAllAvatars(), /已有头像/)
    assert.equal(begins, 1); assert.equal(reads, 0)
    begin.resolve('failure')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(reads, 1)
    const rejected = assert.rejects(first, /Target failed/)
    targets.reject(new Error('Target failed')); await rejected
    assert.deepEqual(ended, ['failure'])
    begin = deferred(); targets = deferred()
    const empty = current.startAllAvatars(); begin.resolve('empty'); targets.resolve([])
    assert.equal(await empty, 0)
    assert.deepEqual(ended, ['failure', 'empty'])
    begin = deferred(); targets = deferred()
    const pendingLock = current.startAllAvatars()
    await unmount(); begin.resolve('late-lock')
    assert.equal(await pendingLock, 0)
    assert.deepEqual(ended, ['failure', 'empty', 'late-lock'])
    assert.equal(reads, 2)
    await mount(); begin = deferred(); targets = deferred()
    const pendingTargets = current.startAllAvatars(); begin.resolve('late-targets')
    await new Promise(resolve => setImmediate(resolve))
    await unmount()
    targets.resolve([{actressId: 1, mainName: 'Never starts'}])
    assert.equal(await pendingTargets, 0)
    assert.deepEqual(ended, ['failure', 'empty', 'late-lock', 'late-targets'])
    await mount(); begin = deferred(); targets = deferred()
    let completed!: Promise<number>
    await act(async () => {
      completed = current.startAllAvatars(); begin.resolve('normal')
      targets.resolve([{actressId: 7, mainName: 'First'}, {actressId: 2, mainName: 'Second'}])
      assert.equal(await completed, 2)
      await new Promise(resolve => setImmediate(resolve))
    })
    assert.deepEqual(processed, [7, 2])
    assert.equal(current.state.status, 'done')
    assert.equal(current.state.current, 2)
    assert.equal(current.state.skipped, 2)
    assert.deepEqual(ended, ['failure', 'empty', 'late-lock', 'late-targets', 'normal'])
    await unmount(); await mount(); begin = deferred(); targets = deferred(); heldSource = deferred()
    await act(async () => {
      const running = current.startAllAvatars(); begin.resolve('active-unmount')
      targets.resolve([{actressId: 11, mainName: 'In flight'}, {actressId: 12, mainName: 'Must not start'}])
      assert.equal(await running, 2)
      await new Promise(resolve => setImmediate(resolve))
    })
    assert.deepEqual(processed, [7, 2, 11])
    await unmount()
    assert.equal(ended.includes('active-unmount'), false, 'active crop must retain the lock until it settles')
    heldSource.resolve(null)
    await act(async () => { await new Promise(resolve => setImmediate(resolve)) })
    assert.deepEqual(processed, [7, 2, 11], 'unmount must discard waiting targets')
    assert.equal(ended.filter(token => token === 'active-unmount').length, 1)
    await mount(); begin = deferred(); targets = deferred(); heldSource = deferred()
    const originalTargets = [{actressId: 21, mainName: 'Stop current'}, {actressId: 22, mainName: 'Skip waiting'}]
    await act(async () => {
      const running = current.startAllAvatars(); begin.resolve('cancel')
      targets.resolve(originalTargets)
      assert.equal(await running, 2)
      await new Promise(resolve => setImmediate(resolve))
      current.cancel()
    })
    assert.equal(current.state.status, 'cancelling')
    assert.equal(ended.includes('cancel'), false)
    assert.deepEqual(originalTargets.map(target => target.actressId), [21, 22])
    heldSource.resolve(null)
    await act(async () => { await new Promise(resolve => setImmediate(resolve)) })
    assert.deepEqual(processed, [7, 2, 11, 21])
    assert.equal(current.state.status, 'done')
    assert.equal(current.state.cancelled, true)
    assert.equal(current.state.current, 1)
    assert.equal(current.state.total, 2)
    assert.equal(ended.filter(token => token === 'cancel').length, 1)
    begin = deferred(); targets = deferred(); heldSource = null
    await act(async () => {
      const many = current.startAllAvatars(); begin.resolve('bounded-logs')
      targets.resolve(Array.from({length:230},(_,i)=>({actressId:100+i,mainName:'Actor-'+i})))
      assert.equal(await many,230)
      await new Promise(resolve=>setImmediate(resolve))
    })
    assert.equal(current.state.current,230)
    assert.equal(current.state.skipped,230)
    assert.equal(current.state.logs.length,200)
    assert.equal(current.state.totalLogCount,232)
    assert.equal(current.state.shortenedLogCount,0)
    assert.match(current.state.logs.at(-1)!.message,/批量构图已完成/)




  } finally { await unmount(); client.clear() }
})
