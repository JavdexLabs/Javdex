import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React, { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useFrozenTargetWindow } from './useFrozenTargetWindow'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

type Row = { id: number; code: string }
let renderer: TestRenderer.ReactTestRenderer | undefined
let client: QueryClient
let result: ReturnType<typeof useFrozenTargetWindow<Row>>

function Harness(props: {
  ids: number[]
  missing: Set<number>
  readPage: (offset: number, limit: number) => Promise<{ ids: number[] }>
}): null {
  result = useFrozenTargetWindow<Row>(
    'list-1',
    props.ids.length,
    1,
    props.readPage,
    async (id) => (props.missing.has(id) ? null : { id, code: `ROW-${id}` })
  )
  return null
}

async function settle(check: () => boolean): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (check()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2))
    })
  }
  assert.fail('frozen target window did not settle')
}

afterEach(async () => {
  await act(async () => renderer?.unmount())
  client?.clear()
})

it('holds three frozen pages and keeps a deleted id as a missing slot', async () => {
  const ids = [1, 2, 3]
  const missing = new Set<number>()
  const pages: number[] = []
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Harness, {
          ids,
          missing,
          readPage: async (offset, limit) => {
            pages.push(offset)
            return { ids: ids.slice(offset, offset + limit) }
          }
        })
      )
    )
  })
  await settle(() => result.window.getItem(0)?.status === 'ready')
  act(() => result.window.onVisibleRange(0, 2))
  await settle(() => result.window.getItem(2)?.status === 'ready')
  assert.equal(result.total, 3)
  assert.equal(result.window.getItem(1)?.status, 'ready')
  missing.add(2)
  act(() => result.retry())
  await settle(() => result.window.getItem(1)?.status === 'missing')
  assert.equal(result.window.getItem(0)?.status, 'ready')
  assert.equal(result.window.getItem(2)?.status, 'ready')
  assert.equal(result.window.getItem(1)?.id, 2)
  assert.equal(result.items.length, 3)
  assert.ok(pages.includes(0) && pages.includes(1) && pages.includes(2))
})
