import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { api: {} }
})

function RedirectTarget(): JSX.Element {
  const location = useLocation()
  return <output data-path={location.pathname} data-state={JSON.stringify(location.state)} />
}

describe('LegacyLibraryRedirect', () => {
  it('preserves the settings return context while replacing a legacy video URL', async () => {
    const { default: LegacyLibraryRedirect } = await import('./LegacyLibraryRedirect')
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } }
    })
    client.setQueryData(['videos', 'legacy-detail', 7, null, null], { activeLibraryId: 1 })
    let renderer: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={client}>
          <MemoryRouter
            initialEntries={[
              {
                pathname: '/detail/7',
                state: { returnToSettings: '/settings/library' }
              }
            ]}
          >
            <Routes>
              <Route path="/detail/:id" element={<LegacyLibraryRedirect detail />} />
              <Route path="/libraries/:libraryId/video/:videoId" element={<RedirectTarget />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      )
      await Promise.resolve()
    })

    const output = renderer!.root.findByType('output')
    assert.equal(output.props['data-path'], '/libraries/1/video/7')
    assert.deepEqual(JSON.parse(output.props['data-state']), {
      returnToSettings: '/settings/library'
    })
    renderer!.unmount()
    client.clear()
  })
})
