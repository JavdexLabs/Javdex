import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

const storage = new Map<string, string>()
let resolveSettings: ((settings: Record<string, unknown>) => void) | null = null

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value)
  }
})
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    api: {
      settings: {
        get: () =>
          new Promise<Record<string, unknown>>((resolve) => {
            resolveSettings = resolve
          }),
        update: async (patch: Record<string, unknown>) => patch
      }
    }
  }
})
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { documentElement: { dataset: {} } }
})

let renderer: TestRenderer.ReactTestRenderer | null = null

afterEach(() => {
  renderer?.unmount()
  renderer = null
  resolveSettings = null
  storage.clear()
})

describe('DisplayModeProvider', () => {
  it('preserves the latest choice across out-of-order saves and restores the last saved size on failure', async (t) => {
    const { DisplayModeProvider, useDisplayMode } = await import('./DisplayModeContext')
    const requests: { resolve: (value: object) => void; reject: () => void }[] = []
    t.mock.method(window.api.settings, 'update', () => new Promise<object>((resolve, reject) => {
      requests.push({ resolve, reject })
    }))
    let display!: ReturnType<typeof useDisplayMode>
    function Harness() { display = useDisplayMode(); return null }
    await act(async () => { renderer = TestRenderer.create(<DisplayModeProvider><Harness /></DisplayModeProvider>) })
    act(() => { void display.persistListPageSize(20); void display.persistListPageSize(50) })
    await act(async () => requests[1].resolve({ listPageSize: 50 }))
    await act(async () => requests[0].resolve({ listPageSize: 20 }))
    assert.equal(display.listPageSize, 50)
    act(() => { void display.persistListPageSize(100) })
    await act(async () => requests[2].reject())
    assert.equal(display.listPageSize, 50)
  })

  it('loads and exposes the application-wide cover mode', async () => {
    const { DisplayModeProvider, useDisplayMode } = await import('./DisplayModeContext')

    function Harness(): JSX.Element {
      const { mode, coverSize, listLoadMode, listPageSize } = useDisplayMode()
      return (
        <span
          data-mode={mode}
          data-cover-size={coverSize}
          data-load-mode={listLoadMode}
          data-page-size={listPageSize}
        >
          {mode}
        </span>
      )
    }

    await act(async () => {
      renderer = TestRenderer.create(
        <DisplayModeProvider>
          <Harness />
        </DisplayModeProvider>
      )
      await Promise.resolve()
    })
    assert.ok(renderer)
    assert.equal(renderer.root.findByType('span').props['data-mode'], 'portrait')
    assert.equal(renderer.root.findByType('span').props['data-cover-size'], 'md')
    assert.equal(renderer.root.findByType('span').props['data-load-mode'], 'scroll')
    assert.equal(renderer.root.findByType('span').props['data-page-size'], 100)

    await act(async () => {
      resolveSettings?.({
        coverDisplayMode: 'landscape',
        coverSizePreset: 'lg',
        listLoadMode: 'paged',
        listPageSize: 50,
        showVideoResourceTypeBadges: false
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    assert.equal(renderer.root.findByType('span').props['data-mode'], 'landscape')
    assert.equal(renderer.root.findByType('span').props['data-cover-size'], 'lg')
    assert.equal(renderer.root.findByType('span').props['data-load-mode'], 'paged')
    assert.equal(renderer.root.findByType('span').props['data-page-size'], 50)
  })
})
