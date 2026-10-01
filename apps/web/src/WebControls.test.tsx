/// <reference types="node" />

import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { createRef } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { WebButton, WebChipLink } from './WebButton'
import WebTextInput from './WebTextInput'
import WebBrand from './WebBrand'
import { LoginField, LoginCopy, RememberDevice, LoginSubmitButton } from './LoginForm'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

test('Web controls preserve native props, refs, caller layout and implicit form submission', () => {
  const buttonRef = createRef<HTMLButtonElement>()
  const inputRef = createRef<HTMLInputElement>()
  const linkRef = createRef<HTMLAnchorElement>()
  const nodes = { button: {}, input: {}, a: {} }
  let calls = 0
  let renderer: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<form>
      <WebButton ref={buttonRef} className="caller-button" disabled={false} name="action"
        value="search" onClick={() => { calls++ }}>搜索</WebButton>
      <WebTextInput ref={inputRef} className="caller-input" name="username" autoComplete="username"
        required maxLength={64} appearance="login" />
      <WebChipLink ref={linkRef} href="/browse?actor=1" className="caller-link">演员</WebChipLink>
    </form>, { createNodeMock: element => nodes[element.type as keyof typeof nodes] ?? null })
  })
  try {
    const button = renderer!.root.findByType('button')
    assert.equal(button.props.type, undefined, 'native implicit submit is not replaced with type=button')
    assert.equal(button.props.disabled, false)
    assert.equal(button.props.name, 'action')
    assert.equal(button.props.value, 'search')
    assert.equal(button.props['data-variant'], 'default')
    assert.match(button.props.className, /caller-button/)
    act(() => { button.props.onClick() })
    assert.equal(calls, 1)
    const input = renderer!.root.findByType('input')
    assert.equal(input.props.name, 'username')
    assert.equal(input.props.autoComplete, 'username')
    assert.equal(input.props.required, true)
    assert.equal(input.props.maxLength, 64)
    assert.equal(input.props['data-appearance'], 'login')
    assert.match(input.props.className, /caller-input/)
    assert.equal(renderer!.root.findByType('a').props.href, '/browse?actor=1')
    assert.equal(buttonRef.current, nodes.button)
    assert.equal(inputRef.current, nodes.input)
    assert.equal(linkRef.current, nodes.a)
  } finally { act(() => renderer!.unmount()) }
})

test('login form parts retain native labels, checkbox changes, alerts and submit commands', () => {
  let checked = false
  let renderer: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<form>
      <LoginField htmlFor="account">访问账号</LoginField>
      <RememberDevice checked={false} onChange={event => { checked = event.target.checked }}>记住此设备</RememberDevice>
      <LoginCopy tone="danger" role="alert">错误仍保留</LoginCopy>
      <LoginSubmitButton disabled type="submit" name="submit" className="caller-submit">进入媒体库</LoginSubmitButton>
      <WebButton variant="chip" type="button">筛选</WebButton>
    </form>)
  })
  try {
    assert.equal(renderer!.root.findAllByType('label')[0].props.htmlFor, 'account')
    const checkbox = renderer!.root.findByType('input')
    assert.equal(checkbox.props.type, 'checkbox')
    assert.equal(checkbox.props.checked, false)
    act(() => { checkbox.props.onChange({ target: { checked: true } }) })
    assert.equal(checked, true)
    assert.equal(renderer!.root.findByType('p').props.role, 'alert')
    const [submit, chip] = renderer!.root.findAllByType('button')
    assert.equal(submit.props.disabled, true)
    assert.equal(submit.props.type, 'submit')
    assert.equal(submit.props.name, 'submit')
    assert.equal(submit.props['data-variant'], 'primary')
    assert.match(submit.props.className, /caller-submit/)
    assert.equal(chip.props['data-variant'], 'chip')
    assert.equal(chip.props.type, 'button')
  } finally { act(() => renderer!.unmount()) }
})

test('Web brand keeps its native link and login display without adding a wrapper', () => {
  let renderer: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<WebBrand href="/browse" description="本地媒体库" />) })
  try {
    assert.equal(renderer!.root.findByType('a').props.href, '/browse')
    assert.equal(renderer!.root.findByType('span').children[0], '本地媒体库')
    assert.equal(renderer!.root.findByType('img').props.alt, '')
    assert.equal(renderer!.root.findAllByType('div').length, 0)
    act(() => { renderer!.update(<WebBrand className="login-brand" />) })
    assert.equal(renderer!.root.findAllByType('a').length, 0)
    assert.equal(renderer!.root.findAllByType('span').length, 0)
    assert.match(renderer!.root.findByType('div').props.className, /login-brand/)
  } finally { act(() => renderer!.unmount()) }
})
