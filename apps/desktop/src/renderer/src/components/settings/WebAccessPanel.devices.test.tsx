import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { WebAccessInput, WebAccessStatus } from '@shared/webTypes'
import ConfirmModal from '../ConfirmModal'
import { renderedText } from '../../test/renderedText'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

it('keeps address actions tied to the saved service and device table actions tied to the confirmed device', async () => {
  const previous = globalThis.window
  const now = Date.now()
  let status: WebAccessStatus = { enabled: false, running: false, port: 8096, username: 'viewer', hasPassword: true,
    urls: [], sessions: 0, pairingUntil: 0, pairingActivity: [], error: null, devices: [
      { id: 'phone', name: '我的手机', remember: true, created: now, touched: now, expires: null },
      { id: 'tv', name: '客厅电视', remember: false, created: now, touched: now, expires: now + 3600000 }
    ] }
  const commands: unknown[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: { webAccess: {
    status: async () => status,
    apply: async (input: WebAccessInput) => {
      commands.push(input)
      status = { ...status, ...input, running: input.enabled, urls: ['http://192.168.1.20:8096'] }
      return status
    },
    deviceRename: async (id: string, name: string) => {
      commands.push(['rename', id, name]); status = { ...status, devices: status.devices.map(device => device.id === id ? { ...device, name } : device) }; return status
    },
    deviceRemove: async (id: string) => {
      commands.push(['remove', id]); status = { ...status, devices: status.devices.filter(device => device.id !== id) }; return status
    },
    revoke: async () => { commands.push(['revoke-all']); status = { ...status, devices: [] }; return status }
  } } } })
  let renderer: TestRenderer.ReactTestRenderer | undefined
  try {
    const { default: Panel } = await import('./WebAccessPanel')
    await act(async () => { renderer = TestRenderer.create(<Panel />) })
    const button = (label: string) => {
      const result = renderer!.root.findAllByType('button').find(node => node.props['aria-label'] === label || renderedText(node) === label)
      assert.ok(result, label); return result
    }
    assert.equal(button('复制访问地址').props.disabled, true)
    assert.equal(button('扫码访问').props.disabled, true)
    assert.equal(button('开启配对').props.disabled, true)
    act(() => renderer!.root.findByProps({ role: 'switch' }).props.onChange({ target: { checked: true } }))
    assert.deepEqual(commands, [])
    assert.equal(button('打开访问地址').props.disabled, true, 'an unsaved enabled draft must not advertise a running service')
    await act(async () => button('保存').props.onClick())
    assert.equal(button('打开访问地址').props.disabled, false)
    assert.equal(button('开启配对').props.disabled, false)
    const table = renderer!.root.findByType('table')
    assert.match(renderedText(table), /设备登录类型最近访问有效期操作/)
    assert.match(renderedText(table), /我的手机已记住.*客厅电视临时登录/)

    act(() => button('重命名“客厅电视”').props.onClick())
    const rename = renderer!.root.findByType(ConfirmModal)
    assert.equal(rename.props.title, '重命名设备')
    act(() => rename.findByType('input').props.onChange({ target: { value: '卧室电视' } }))
    await act(async () => renderer!.root.findByType(ConfirmModal).props.onConfirm())
    assert.deepEqual(commands.at(-1), ['rename', 'tv', '卧室电视'])
    assert.match(renderedText(table), /卧室电视/)

    act(() => button('撤销“卧室电视”的授权').props.onClick())
    assert.match(renderedText(renderer!.root.findByType(ConfirmModal)), /其他设备不受影响/)
    assert.equal(status.devices.length, 2)
    act(() => renderer!.root.findByType(ConfirmModal).props.onCancel())
    assert.equal(status.devices.length, 2)
    act(() => button('撤销“卧室电视”的授权').props.onClick())
    await act(async () => renderer!.root.findByType(ConfirmModal).props.onConfirm())
    assert.deepEqual(commands.at(-1), ['remove', 'tv'])
    assert.deepEqual(status.devices.map(device => device.id), ['phone'])

    act(() => button('退出所有设备').props.onClick())
    assert.equal(renderer!.root.findByType(ConfirmModal).props.title, '退出所有设备')
    await act(async () => renderer!.root.findByType(ConfirmModal).props.onConfirm())
    assert.deepEqual(commands.at(-1), ['revoke-all'])
    assert.equal(renderer!.root.findAllByType('table').length, 0)
    assert.match(renderedText(renderer!.root), /暂无授权设备/)
    assert.equal(button('退出所有设备').props.disabled, true)
  } finally {
    if (renderer) act(() => renderer!.unmount())
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous })
  }
})
