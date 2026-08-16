import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import useLatestAsyncLabel, { type LatestAsyncLabelController } from './useLatestAsyncLabel'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

let renderer: TestRenderer.ReactTestRenderer | null = null

afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = null
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function mount(): Promise<() => LatestAsyncLabelController> {
  let controller: LatestAsyncLabelController | null = null
  function Harness(): null {
    controller = useLatestAsyncLabel('- 项')
    return null
  }
  await act(async () => {
    renderer = TestRenderer.create(<Harness />)
  })
  return () => {
    assert.ok(controller)
    return controller
  }
}

describe('useLatestAsyncLabel', () => {
  it('ignores an older request that finishes after the latest request', async () => {
    const first = deferred<number>()
    const second = deferred<number>()
    const current = await mount()

    await act(async () => {
      void current().refresh(() => first.promise, (value) => `${value} 项`)
      void current().refresh(() => second.promise, (value) => `${value} 项`)
      second.resolve(2)
      await second.promise
    })
    assert.equal(current().label, '2 项')

    await act(async () => {
      first.resolve(1)
      await first.promise
    })
    assert.equal(current().label, '2 项')
  })
})
