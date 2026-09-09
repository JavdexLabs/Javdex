import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

it('retries a failed service with saved configuration, and prevents submitting unsaved drafts via retry', async () => {
  const previous = globalThis.window
  let status = { enabled: true, running: false, port: 8088, username: 'viewer', hasPassword: true, urls: ['http://192.168.1.20:8088'], devices: [], sessions: 0, pairingUntil: 0, pairingActivity: [], error: '端口被占用' }
  const applied: unknown[] = []
  const inspected: string[] = []
  const previousFrame = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = () => 0
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: { webAccess: {
    status: async () => status,
    pairOpen: async () => { status = { ...status, pairingUntil: Date.now() + 300000 }; return status },
    pairInspect: async (code: string) => { inspected.push(code); return { name: '测试手机', expires: Date.now() + 60000, remember: true } },
    pairDecide: async () => status,
    apply: async (input: unknown) => { applied.push(input); status = { ...status, running: true, error: '' }; return status }
  }, externalLinks: { open: async () => { throw new Error('无法打开浏览器') } } } } })
  let renderer!: TestRenderer.ReactTestRenderer
  try {
    const { default: Panel } = await import('./WebAccessPanel')
    await act(async () => { renderer = TestRenderer.create(<Panel />) })
    const retry = () => renderer.root.findAllByType('button').find(button => button.children.includes('重试启动'))!
    assert.equal(retry().props.disabled, false)
    const port = renderer.root.findAllByType('input').find(input => input.props.value === '8088')!
    act(() => port.props.onChange({ target: { value: '8090' } }))
    assert.equal(retry().props.disabled, true)
    act(() => port.props.onChange({ target: { value: '8088' } }))
    await act(async () => { retry().props.onClick() })
    assert.equal(applied.length, 1)
    assert.equal(retry(), undefined)
    const button = (text: string) => renderer.root.findAllByType('button').find(item => item.children.includes(text))!
    await act(async () => { button('打开').props.onClick() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 3100)) })
    assert.ok(JSON.stringify(renderer.toJSON()).includes('无法打开浏览器'), 'errors remain after the success timeout')
    act(() => button('关闭提示').props.onClick())
    assert.ok(!JSON.stringify(renderer.toJSON()).includes('无法打开浏览器'))
    await act(async () => { button('开启配对').props.onClick() })
    const codeInput = () => renderer.root.findAllByType('input').find(input => input.props.autoComplete === 'one-time-code')!
    act(() => codeInput().props.onPaste({ preventDefault() {}, currentTarget: { selectionStart: 0, selectionEnd: 0 }, clipboardData: { getData: () => '897 982' } }))
    assert.equal(codeInput().props.value, '897982')
    assert.equal(codeInput().props.maxLength, 6)
    await act(async () => { button('核对设备').props.onClick() })
    assert.deepEqual(inspected, ['897982'])
    assert.ok(button('允许登录'))
    await act(async () => { button('拒绝').props.onClick() })
    assert.equal(codeInput().props.value, '897982')
  } finally {
    globalThis.requestAnimationFrame = previousFrame
    if (renderer) act(() => renderer.unmount())
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous })
  }
})
