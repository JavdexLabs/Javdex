import assert from 'node:assert/strict'
import { afterEach, before, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import Button from '../Button'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: {} } })

let PluginDevConfigRail: typeof import('./PluginDevConfigRail').default

before(async () => {
  PluginDevConfigRail = (await import('./PluginDevConfigRail')).default
})

let renderer: TestRenderer.ReactTestRenderer | null = null

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

describe('PluginDevConfigRail ready actions', () => {
  it('makes Install primary and disables empty continuation until feedback is entered', () => {
    const props = {
      kind: 'video' as const,
      siteName: 'fixture',
      siteUrl: 'https://example.test',
      testTarget: 'ABC-123',
      description: '',
      version: '1.0.0',
      author: 'Plugin Dev Agent',
      supportedFields: ['title'],
      fieldLabel: (_kind: 'video' | 'actress', field: string) => field,
      loadedInstalledName: null,
      forkedFromBuiltIn: null,
      selectedPluginName: '',
      selectablePlugins: [],
      pluginsLoading: false,
      busy: false,
      canUseAgent: true,
      hasPackage: true,
      canResumeAgent: true,
      agentCompleted: false,
      agentReady: true,
      feedbackPending: false,
      agentDisabledReason: null,
      agentPrimaryDisabledReason: '如需继续完善，请先输入具体反馈。',
      activeLlmReady: true,
      agentBusy: false,
      installBusy: false,
      canInstall: true,
      onSelectPlugin: () => undefined,
      onStartAgent: () => undefined,
      onInstall: () => undefined,
      onSiteNameChange: () => undefined,
      onSiteUrlChange: () => undefined,
      onTestTargetChange: () => undefined,
      onDescriptionChange: () => undefined,
      onVersionChange: () => undefined,
      onAuthorChange: () => undefined,
      onSupportedFieldsChange: () => undefined
    }

    act(() => {
      renderer = TestRenderer.create(<PluginDevConfigRail {...props} />)
    })

    let buttons = renderer?.root.findAllByType(Button) ?? []
    let continueButton = buttons.find((button) => button.props.children === '输入反馈后继续')
    let installButton = buttons.find((button) => button.props.children === '安装')
    assert.ok(continueButton)
    assert.ok(installButton)
    assert.equal(continueButton.props.variant, 'default')
    assert.equal(continueButton.props.disabled, true)
    assert.equal(installButton.props.variant, 'primary')
    assert.equal(installButton.props.disabled, false)

    act(() => {
      renderer?.update(
        <PluginDevConfigRail
          {...props}
          feedbackPending
          agentPrimaryDisabledReason={null}
        />
      )
    })
    buttons = renderer?.root.findAllByType(Button) ?? []
    continueButton = buttons.find((button) => button.props.children === '继续修复')
    installButton = buttons.find((button) => button.props.children === '安装')
    assert.ok(continueButton)
    assert.ok(installButton)
    assert.equal(continueButton.props.variant, 'default')
    assert.equal(continueButton.props.disabled, false)
    assert.equal(installButton.props.variant, 'primary')
  })
})
