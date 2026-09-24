import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { useSettingsDraft } from './useSettingsDraft'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

it('keeps edits through unrelated refreshes and explicitly resets to the latest saved value', () => {
  let form!: ReturnType<typeof useSettingsDraft<{ name: string }>>
  function Harness({ saved }: { saved: { name: string } }) {
    form = useSettingsDraft(saved)
    return null
  }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<Harness saved={{ name: 'saved' }} />)
  })
  act(() => form.setDraft({ name: 'my draft' }))
  act(() => renderer.update(<Harness saved={{ name: 'external change' }} />))
  assert.equal(form.draft.name, 'my draft')
  assert.equal(form.conflict, true)
  act(() => form.reset())
  assert.equal(form.draft.name, 'external change')
  assert.equal(form.dirty, false)
  act(() => renderer.unmount())
})

it('preserves edits made while an earlier value is being saved', () => {
  let form!: ReturnType<typeof useSettingsDraft<string>>
  function Harness({ saved }: { saved: string }) {
    form = useSettingsDraft(saved)
    return null
  }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<Harness saved="initial" />)
  })
  act(() => form.setDraft('submitted'))
  act(() => form.setDraft('typed while saving'))
  act(() => {
    renderer.update(<Harness saved="submitted" />)
    form.accept('submitted')
  })
  assert.equal(form.draft, 'typed while saving')
  assert.equal(form.dirty, true)
  act(() => form.reset())
  assert.equal(form.draft, 'submitted')
  act(() => renderer.unmount())
})
