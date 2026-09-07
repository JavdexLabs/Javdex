import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { createMemoryRouter, RouterProvider, Routes, Route } from 'react-router-dom'
import SettingsLeaveGuard, { useSettingsFormGuard } from './SettingsLeaveGuard'
import { useSettingsDraft } from './useSettingsDraft'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

it('blocks route changes with a draft and saves before continuing through the real router', async () => {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { addEventListener() {}, removeEventListener() {} }
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { body: { style: {} }, activeElement: null }
  })
  const saved: string[] = []
  function Form() {
    const form = useSettingsDraft('saved')
    useSettingsFormGuard({
      label: '测试配置',
      dirty: form.dirty,
      discard: form.reset,
      save: async () => {
        saved.push(form.draft)
        form.accept(form.draft)
        return true
      }
    })
    return <input value={form.draft} onChange={(event) => form.setDraft(event.target.value)} />
  }
  const router = createMemoryRouter([
    {
      path: '*',
      element: (
        <SettingsLeaveGuard>
          <Routes>
            <Route path="/" element={<Form />} />
            <Route path="/next" element={<p>目标页面</p>} />
          </Routes>
        </SettingsLeaveGuard>
      )
    }
  ])
  let renderer!: TestRenderer.ReactTestRenderer
  try {
    await act(async () => {
      renderer = TestRenderer.create(<RouterProvider router={router} />)
    })
    act(() => renderer.root.findByType('input').props.onChange({ target: { value: 'edited' } }))
    await act(async () => {
      await router.navigate('/next')
    })
    assert.equal(router.state.location.pathname, '/')
    const stay = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('继续编辑'))!
    act(() => stay.props.onClick())
    assert.equal(renderer.root.findByType('input').props.value, 'edited')
    await act(async () => {
      await router.navigate('/next')
    })
    const save = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('保存后离开'))!
    await act(async () => {
      save.props.onClick()
    })
    assert.deepEqual(saved, ['edited'])
    assert.equal(router.state.location.pathname, '/next')
  } finally {
    act(() => renderer?.unmount())
    router.dispose()
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument })
  }
})
