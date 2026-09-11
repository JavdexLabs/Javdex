import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ElectronApi } from '../../../preload/index'

it('counts avatars through the scalar API without loading targets and propagates failures', async () => {
  let calls = 0
  let value = 300382
  let failure = false
  let unsubscribed = false
  const fake = {
    actresses: {
      list: () => { throw new Error('Full target list forbidden for counting') },
      countAvatarCropTargets: async () => { calls++; if (failure) throw new Error('Count failed'); return value }
    },
    actressScrape: { onAvatarAutoCropRequest: () => () => { unsubscribed = true } }
  } as unknown as ElectronApi
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: fake } })
  const { AvatarAutoCropBatchProvider, useAvatarAutoCropBatch } = await import('./AvatarAutoCropBatchContext')
  let current!: ReturnType<typeof useAvatarAutoCropBatch>
  function Probe() { current = useAvatarAutoCropBatch(); return null }
  const client = new QueryClient()
  let renderer!: TestRenderer.ReactTestRenderer
  try {
    await act(async () => { renderer = TestRenderer.create(
      <QueryClientProvider client={client}><AvatarAutoCropBatchProvider><Probe /></AvatarAutoCropBatchProvider></QueryClientProvider>
    ) })
    assert.equal(await current.countAllAvatars(), 300382)
    value = 0
    assert.equal(await current.countAllAvatars(), 0)
    failure = true
    await assert.rejects(current.countAllAvatars(), /Count failed/)
    assert.equal(calls, 3)
    assert.equal(current.state.status, 'idle')
    assert.equal(current.state.total, 0)
  } finally {
    await act(async () => renderer?.unmount())
    client.clear()
  }
  assert.equal(unsubscribed, true)
})
