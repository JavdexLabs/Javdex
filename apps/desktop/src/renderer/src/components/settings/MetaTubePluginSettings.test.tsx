import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act, type ReactTestRendererJSON } from 'react-test-renderer'
import type {
  ScraperPluginDescriptor,
  ScraperServiceConfigInput,
  ScraperServicePublicConfig
} from '@shared/scrapeTypes'
import PluginCard from '../PluginCard'
import { PluginConfigModal } from './PluginConfigModals'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    addEventListener() {},
    removeEventListener() {},
  }
})
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { activeElement: null, body: { style: { overflow: '' } } }
})

let renderer: TestRenderer.ReactTestRenderer | null = null

const metaTube: ScraperPluginDescriptor = {
  kind: 'video',
  name: 'MetaTube',
  version: '1.0.0',
  description: 'MetaTube fixture',
  source: 'builtin',
  removable: false,
  exportable: false,
  editable: false,
  debuggable: false,
  requiresConfiguration: true,
  configured: false,
  configurationLabel: '待配置',
  disabledReason: '请先配置 MetaTube 服务端地址',
  supportedFields: ['title', 'actressesFemale'],
  delay: { minMs: 0, maxMs: 0 }
}

const publicConfig: ScraperServicePublicConfig = {
  serverUrl: 'https://server.test/prefix',
  useScrapeProxy: false,
  keepFirstCandidate: false,
  hasToken: true,
  secretProtection: 'secure'
}

function text(): string {
  type RenderNode = string | ReactTestRendererJSON | RenderNode[] | null
  const collect = (node: RenderNode): string => {
    if (node == null) return ''
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(collect).join('')
    return node.children?.map(collect).join('') ?? ''
  }
  return collect(renderer?.toJSON() ?? null)
}

function button(label: string): TestRenderer.ReactTestInstance {
  assert.ok(renderer)
  const found = renderer.root.findAllByType('button').find((item) => item.props.children === label)
  assert.ok(found, `missing button ${label}`)
  return found
}

function serviceInput(placeholder: string): TestRenderer.ReactTestInstance {
  assert.ok(renderer)
  const found = renderer.root
    .findAllByType('input')
    .find((item) => item.props.placeholder === placeholder)
  assert.ok(found, `missing input ${placeholder}`)
  return found
}

function renderEditor(
  config: ScraperServicePublicConfig,
  onSave: (service?: ScraperServiceConfigInput) => void,
  onTestService?: (input: ScraperServiceConfigInput) => Promise<{
    app: 'metatube'
    version: string
    dbVersion: string
    movieProviderCount: number
  }>
): void {
  act(() => {
    renderer = TestRenderer.create(
      <PluginConfigModal
        state={{ kind: 'video', plugin: metaTube, serviceConfig: config }}
        onSave={(_kind, _name, _input, service) => onSave(service)}
        onTestService={onTestService}
        onClearService={async () => {}}
        onCancel={() => {}}
      />
    )
  })
}

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

describe('MetaTube plugin settings', () => {
  it('shows pending status and blocks setting an unconfigured plugin as default', () => {
    act(() => {
      renderer = TestRenderer.create(
        <PluginCard
          plugin={metaTube}
          allFieldCount={15}
          isDefault={false}
          actionsDisabled={false}
          onEdit={() => {}}
          onExport={() => assert.fail('must not export')}
          onAiDebug={() => assert.fail('must not debug')}
          onRequestDelete={() => assert.fail('must not delete')}
          onSetDefault={() => assert.fail('must not set default')}
        />
      )
    })

    assert.match(text(), /待配置/)
    assert.equal(button('设为全局默认').props.disabled, true)
    assert.equal(button('配置服务端').props.disabled, false)
    assert.equal(
      renderer?.root.findAllByType('button').some((item) => item.props['aria-label'] === '更多操作'),
      false
    )
  })

  it('keeps a blank token and supports explicit token clearing', () => {
    const saved: ScraperServiceConfigInput[] = []
    renderEditor(publicConfig, (input) => {
      if (input) saved.push(input)
    })

    act(() => button('保存').props.onClick())
    assert.deepEqual(saved[0]?.tokenUpdate, { mode: 'keep' })

    act(() => button('清除令牌').props.onClick())
    act(() => button('保存').props.onClick())
    assert.deepEqual(saved[1]?.tokenUpdate, { mode: 'clear' })
  })

  it('requires confirmation before saving a token over remote HTTP', () => {
    const saved: ScraperServiceConfigInput[] = []
    renderEditor(
      { ...publicConfig, serverUrl: 'http://192.168.1.8:8080', hasToken: false },
      (input) => {
        if (input) saved.push(input)
      }
    )
    act(() => {
      serviceInput('服务端未启用 Token 时留空').props.onChange({ target: { value: 'draft-token' } })
    })

    act(() => button('保存').props.onClick())
    assert.equal(saved.length, 0)
    assert.match(text(), /通过 HTTP 保存服务连接/)
    act(() => button('仍要保存').props.onClick())
    assert.deepEqual(saved[0]?.tokenUpdate, { mode: 'set', value: 'draft-token' })
    assert.equal(saved[0]?.acknowledgeInsecureHttp, true)
    assert.match(text(), /HTTP 可能暴露查询番号和访问令牌/)
  })

  it('tests the current draft without changing the token mode', async () => {
    const tested: ScraperServiceConfigInput[] = []
    renderEditor(publicConfig, () => {}, async (input) => {
      tested.push(input)
      return {
        app: 'metatube',
        version: 'v1.4.0',
        dbVersion: '42',
        movieProviderCount: 3
      }
    })

    await act(async () => {
      button('测试连接').props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    assert.deepEqual(tested[0]?.tokenUpdate, { mode: 'keep' })
    assert.match(text(), /连接成功 · v1.4.0 · DB 42 · 3 个影片源/)
  })

  it('defaults keepFirstCandidate off and saves the switch', () => {
    const saved: ScraperServiceConfigInput[] = []
    renderEditor(publicConfig, (input) => {
      if (input) saved.push(input)
    })

    assert.match(text(), /只保留第一个候选/)
    assert.match(text(), /不再进入待确认/)
    const toggle = renderer?.root
      .findAllByType('input')
      .find((item) => item.props['aria-label'] === '只保留第一个候选')
    assert.ok(toggle)
    assert.equal(toggle.props.checked, false)

    act(() => button('保存').props.onClick())
    assert.equal(saved[0]?.keepFirstCandidate, false)

    act(() => toggle.props.onChange({ target: { checked: true } }))
    act(() => button('保存').props.onClick())
    assert.equal(saved[1]?.keepFirstCandidate, true)
    assert.equal(
      renderer?.root.findAllByType('input').some((item) => item.props['aria-label'] === '刮削前预登入'),
      false
    )
    assert.doesNotMatch(text(), /预登入/)
  })

  it('saves the pre-login switch for website plugins', () => {
    const javdb: ScraperPluginDescriptor = {
      kind: 'video',
      name: 'JavDB',
      version: 'built-in',
      description: 'JavDB fixture',
      source: 'builtin',
      removable: false,
      exportable: true,
      editable: false,
      debuggable: true,
      homepage: 'https://javdb.com/',
      supportedFields: ['title'],
      delay: { minMs: 0, maxMs: 0 },
      preLoginAvailable: true,
      preLogin: false
    }
    const saved: Array<{ preLogin?: boolean }> = []
    act(() => {
      renderer = TestRenderer.create(
        <PluginConfigModal
          state={{ kind: 'video', plugin: javdb }}
          onSave={(_kind, _name, input) => saved.push(input)}
          onCancel={() => {}}
        />
      )
    })
    const toggle = renderer?.root
      .findAllByType('input')
      .find((item) => item.props['aria-label'] === '刮削前预登入')
    assert.ok(toggle)
    assert.equal(toggle.props.checked, false)
    act(() => toggle.props.onChange({ target: { checked: true } }))
    act(() => button('保存').props.onClick())
    assert.equal(saved[0]?.preLogin, true)
  })
})
