import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { CoverDisplayMode } from '@shared/settingsTypes'

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
  it('keeps a library override through async settings load and restores the app default on exit', async () => {
    const {
      DisplayModeProvider,
      useDisplayMode,
      useScopedDisplayMode
    } = await import('./DisplayModeContext')

    function Harness({ libraryMode }: { libraryMode: CoverDisplayMode | null }): JSX.Element {
      useScopedDisplayMode(libraryMode)
      const { mode } = useDisplayMode()
      return <span data-mode={mode}>{mode}</span>
    }

    await act(async () => {
      renderer = TestRenderer.create(
        <DisplayModeProvider>
          <Harness libraryMode="landscape" />
        </DisplayModeProvider>
      )
      await Promise.resolve()
    })
    assert.ok(renderer)
    assert.equal(renderer.root.findByType('span').props['data-mode'], 'landscape')

    await act(async () => {
      resolveSettings?.({
        coverDisplayMode: 'portrait',
        showVideoResourceTypeBadges: false
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    assert.equal(renderer.root.findByType('span').props['data-mode'], 'landscape')

    act(() => {
      renderer?.update(
        <DisplayModeProvider>
          <Harness libraryMode={null} />
        </DisplayModeProvider>
      )
    })
    assert.equal(renderer.root.findByType('span').props['data-mode'], 'portrait')
  })
})
