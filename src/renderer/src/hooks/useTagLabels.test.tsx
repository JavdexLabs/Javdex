import assert from 'node:assert/strict'
import { afterEach, before, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { TagLabel } from '@shared/commonTypes'

function deferred() {
  let resolve!: (rows: TagLabel[]) => void
  let reject!: (error: Error) => void
  const promise = new Promise<TagLabel[]>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const requests: Array<{ ids: number[] } & ReturnType<typeof deferred>> = []
Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  api: { tags: { labels(ids: number[]) {
    const request = { ids, ...deferred() }
    requests.push(request)
    return request.promise
  } } }
} })
let useTagLabels: typeof import('./useTagLabels')['useTagLabels']
before(async () => { ({ useTagLabels } = await import('./useTagLabels')) })
let renderer: TestRenderer.ReactTestRenderer | undefined
function View({ ids, enabled = true }: { ids: number[]; enabled?: boolean }) {
  const labels = useTagLabels(ids, enabled)
  return <span>{JSON.stringify([...labels])}</span>
}
function value() { return renderer!.root.findByType('span').children.join('') }
async function show(ids: number[], enabled = true) {
  await act(async () => {
    if (renderer) renderer.update(<View ids={ids} enabled={enabled} />)
    else renderer = TestRenderer.create(<View ids={ids} enabled={enabled} />)
  })
}
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  requests.length = 0
})

it('does not fetch empty/inactive selections and resolves only unique selected IDs', async () => {
  await show([])
  await show([1], false)
  assert.equal(requests.length, 0)
  await show([3, 1, 3])
  assert.deepEqual(requests[0].ids, [1, 3])
  await act(async () => requests[0].resolve([{ id: 1, label: 'One' }]))
  assert.equal(value(), '[[1,"One"]]')
  await show([1, 3])
  assert.equal(requests.length, 1, 'missing ID is a completed lookup, not a render-driven retry')
  await show([])
  assert.equal(value(), '[]')
  await show(Array(101).fill(1))
  assert.equal(requests.length, 1)
})

it('ignores responses for previous filters and refreshes on returning from detail', async () => {
  await show([1])
  await show([2])
  await act(async () => requests[1].resolve([{ id: 2, label: 'Current' }]))
  await act(async () => requests[0].resolve([{ id: 1, label: 'Old' }]))
  assert.equal(value(), '[[2,"Current"]]')
  await show([2], false)
  await show([2], true)
  assert.equal(requests.length, 3)
  await act(async () => requests[2].resolve([]))
  assert.equal(value(), '[]')
  await show([2])
  assert.equal(requests.length, 3)
})

it('does not loop on a rejected lookup and discards in-flight results after deactivation', async () => {
  await show([1])
  await act(async () => requests[0].reject(new Error('database unavailable')))
  assert.equal(value(), '[]')
  await show([1])
  assert.equal(requests.length, 1)
  await show([2])
  await show([2], false)
  await act(async () => requests[1].resolve([{ id: 2, label: 'Late' }]))
  assert.equal(value(), '[]')
})
