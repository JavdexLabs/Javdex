import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'
import { useRelatedVideoOffset } from './useRelatedVideoOffset'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
let renderer: TestRenderer.ReactTestRenderer | undefined
let navigate: NavigateFunction
let location: ReturnType<typeof useLocation>
let offset: ReturnType<typeof useRelatedVideoOffset>

function Probe() { navigate = useNavigate(); location = useLocation(); return null }
function Detail() { offset = useRelatedVideoOffset('actress:1'); return null }
async function mount(initial = '/actresses/1') {
  await act(async () => {
    renderer = TestRenderer.create(<MemoryRouter initialEntries={[initial]}><Probe /><Routes>
      <Route path="/actresses/1" element={<Detail />} />
      <Route path="/actresses" element={<div />} />
    </Routes></MemoryRouter>)
  })
}
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined })

it('does not create a navigation for an unchanged scroll page', async () => {
  await mount()
  const key = location.key
  await act(async () => offset.move(0))
  assert.equal(location.key, key)
})

it('ignores a queued scroll callback after leaving its detail route', async () => {
  await mount('/actresses/1?relatedVideoOffset=60')
  const queuedMove = offset.move
  const queuedAlign = offset.align
  await act(async () => navigate('/actresses'))
  await act(async () => { queuedMove(120); queuedAlign(true, 0) })
  assert.equal(location.pathname, '/actresses')
  assert.equal(location.search, '')
})

it('does not let an old scroll callback overwrite a newer route query', async () => {
  await mount('/actresses/1?q=A')
  const queuedMove = offset.move
  await act(async () => navigate('/actresses/1?q=B'))
  await act(async () => queuedMove(60))
  assert.equal(location.search, '?q=B')
})
