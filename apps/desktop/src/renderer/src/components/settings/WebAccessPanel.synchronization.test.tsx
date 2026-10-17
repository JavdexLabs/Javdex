import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import SettingsFormActions from './SettingsFormActions'
import type { WebAccessStatus } from '@shared/webTypes'
import { renderedText } from '../../test/renderedText'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

it('ignores a status poll started before saving and serializes device actions with configuration writes', async () => {
  const previous = globalThis.window
  let status: WebAccessStatus = { enabled: true, running: true, port: 8096, username: 'viewer', hasPassword: true,
    urls: ['http://127.0.0.1:8096'], devices: [], sessions: 0, pairingUntil: 0, pairingActivity: [], error: null }
  let reads = 0, applied = 0, opened = 0
  let oldPoll: ((value: WebAccessStatus) => void) | undefined
  let finishSave: (() => void) | undefined
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: { webAccess: {
    status: () => ++reads === 2 ? new Promise<WebAccessStatus>(resolve => { oldPoll = resolve }) : Promise.resolve(status),
    apply: async (input: { port: number }) => {
      applied++
      await new Promise<void>(resolve => { finishSave = resolve })
      status = { ...status, port: input.port, urls: [`http://127.0.0.1:${input.port}`] }
      return status
    },
    pairOpen: async () => { opened++; return status }
  } } } })
  let renderer: TestRenderer.ReactTestRenderer | undefined
  const wait = async (check: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 300 && !check(); attempt++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.ok(check(), 'web status did not settle')
  }
  try {
    const Panel = (await import('./WebAccessPanel')).default
    await act(async () => { renderer = TestRenderer.create(<Panel />) })
    const portInput = () => renderer!.root.findAllByType('input').find(input => input.props['aria-label'] === '端口')!
    act(() => portInput().props.onChange({ target: { value: '8097' } }))
    await wait(() => !!oldPoll)
    const stale = { ...status }
    act(() => renderer!.root.findByType(SettingsFormActions).props.onSave())
    await wait(() => !!finishSave)
    const pairing = renderer!.root.findAllByType('button').find(button => renderedText(button) === '开启配对')!
    assert.equal(pairing.props.disabled, true)
    await act(async () => pairing.props.onClick())
    assert.equal(opened, 0, 'a device mutation cannot race an ongoing configuration write')
    await act(async () => finishSave!())
    assert.equal(applied, 1)
    await act(async () => oldPoll!(stale))
    assert.equal(portInput().props.value, '8097')
    assert.equal(renderer!.root.findByType(SettingsFormActions).props.conflict, false)
    assert.equal(renderer!.root.findByType(SettingsFormActions).props.dirty, false)
  } finally {
    if (renderer) act(() => renderer!.unmount())
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous })
  }
})
