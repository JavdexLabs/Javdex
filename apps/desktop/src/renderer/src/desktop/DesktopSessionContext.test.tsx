import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { DesktopSessionSnapshot } from '@shared/desktop/session'
import { DesktopSessionProvider, useDesktopSession } from './DesktopSessionContext'
import { queryClient } from '../query/queryClient'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

let renderer: TestRenderer.ReactTestRenderer | null = null

afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = null
  queryClient.clear()
})

it('a late startup snapshot cannot overwrite authentication failure; recovery preserves mounted drafts', async () => {
  let resolveInitial!: (snapshot: DesktopSessionSnapshot) => void
  let notify!: (snapshot: DesktopSessionSnapshot) => void
  const originalWindow = globalThis.window
  const initial = new Promise<DesktopSessionSnapshot>(resolve => { resolveInitial = resolve })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: { desktop: {
    getSession: () => initial,
    onSessionChanged: (callback: typeof notify) => { notify = callback; return () => undefined }
  } } } })
  const snapshot = (state: 'authInvalid' | 'available', generation = 1): DesktopSessionSnapshot => ({
    session: { state, generation, mode: 'remote', catalogId: 'catalog', serverId: 'server', writerEpoch: 1,
      frozen: false, appVersion: 'test', schemaVersion: 19, message: null }, capabilities: {} as never
  })
  function Draft(): JSX.Element {
    const [value, setValue] = React.useState('未保存的演员姓名')
    const { session } = useDesktopSession()
    return <><input value={value} onChange={event => setValue(event.target.value)} /><span>{session.state}</span></>
  }
  try {
    await act(async () => { renderer = TestRenderer.create(<DesktopSessionProvider><Draft /></DesktopSessionProvider>) })
    await act(async () => notify(snapshot('authInvalid')))
    await act(async () => { resolveInitial(snapshot('available')); await initial })
    assert.equal(renderer!.root.findByType('span').children[0], 'authInvalid')
    await act(async () => notify(snapshot('available', 2)))
    assert.equal(renderer!.root.findByType('span').children[0], 'available')
    assert.equal(renderer!.root.findByType('input').props.value, '未保存的演员姓名')
  } finally { Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow }) }
})

it('reloads a mounted home query when the initial remote session arrives', async () => {
  let resolveSession!: (snapshot: DesktopSessionSnapshot) => void
  let onSessionChanged!: (snapshot: DesktopSessionSnapshot) => void
  const initialSession = new Promise<DesktopSessionSnapshot>((resolve) => {
    resolveSession = resolve
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: { desktop: {
        getSession: () => initialSession,
        onSessionChanged: (callback: typeof onSessionChanged) => {
          onSessionChanged = callback
          return () => undefined
        }
      } }
    }
  })
  const snapshot = (generation: number): DesktopSessionSnapshot => ({
    session: {
      state: 'available', mode: 'remote', catalogId: 'remote-catalog',
      serverId: 'server', generation, writerEpoch: 1, frozen: false,
      appVersion: 'test', schemaVersion: 1, message: null
    },
    capabilities: {} as DesktopSessionSnapshot['capabilities']
  })
  let calls = 0
  function HomeQuery(): JSX.Element {
    const result = useQuery({
      queryKey: ['home', 'startup-regression'],
      queryFn: async () => {
        calls += 1
        if (calls === 1) return new Promise<string>(() => undefined)
        return `loaded-${calls}`
      },
      retry: false
    })
    return <span>{result.data ?? 'loading'}</span>
  }
  const text = (): string => renderer?.root.findByType('span').children.join('') ?? ''
  const waitForText = async (expected: string): Promise<void> => {
    for (let attempt = 0; attempt < 50 && text() !== expected; attempt += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    }
    assert.equal(text(), expected)
  }

  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <DesktopSessionProvider><HomeQuery /></DesktopSessionProvider>
      </QueryClientProvider>
    )
  })
  assert.equal(calls, 1)
  assert.equal(text(), 'loading')

  await act(async () => {
    resolveSession(snapshot(2))
    await initialSession
  })
  assert.equal(calls, 2)
  await waitForText('loaded-2')

  await act(async () => onSessionChanged(snapshot(3)))
  assert.equal(calls, 3)
  await waitForText('loaded-3')
})
