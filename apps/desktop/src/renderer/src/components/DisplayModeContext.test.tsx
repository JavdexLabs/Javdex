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
  it('loads and exposes the application-wide cover mode', async () => {
    const { DisplayModeProvider, useDisplayMode } = await import('./DisplayModeContext')

    function Harness(): JSX.Element {
      const { mode } = useDisplayMode()
      return <span data-mode={mode}>{mode}</span>
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

    await act(async () => {
      resolveSettings?.({
        coverDisplayMode: 'landscape',
        showVideoResourceTypeBadges: false
      })
      await Promise.resolve()
      await Promise.resolve()
    })
    assert.equal(renderer.root.findByType('span').props['data-mode'], 'landscape')
  })
})
