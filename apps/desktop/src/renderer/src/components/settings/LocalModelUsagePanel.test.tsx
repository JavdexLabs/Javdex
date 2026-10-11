import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import type { LocalModelCommand, LocalModelSnapshot } from '@shared/desktop/localModels'
import type { SettingsSnapshot } from '@shared/settingsTypes'
import type { ElectronApi } from '../../../../preload/index'
import { OverlayHistoryProvider } from '../../interaction/OverlayHistoryContext'
import { NavigationGuardProvider } from '../../interaction/NavigationGuard'
import SettingsLeaveGuard from '../../settings/SettingsLeaveGuard'
import { preservesModelUsageDraft, resolveSettingsRoute, settingsPath } from '../../settings/settingsRoutes'
import { renderedText } from '../../test/renderedText'

const original: LocalModelSnapshot = {
  revision: 'r1', usage: {
    subtitleRecognition: { model: 'kotoba', variant: 'kotoba-q5_0' },
    subtitleTranslation: { model: 'qwen3', variant: 'qwen3-q4_k_m' },
    textTranslation: { mode: 'app-default', model: 'qwen3', variant: 'qwen3-q4_k_m' }
  }, downloadSource: 'hf-mirror', directory: '/models', defaultDirectory: '/models', supported: true,
  translation: 'app-default', translationModel: 'qwen3', operation: null, activeModel: null, activeVariant: null,
  downloadBytes: 0, downloadTotal: 0, downloadLabel: null, error: null,
  models: ['kotoba', 'qwen3', 'hy-mt2-7b'].map(id => ({
    id: id as 'kotoba' | 'qwen3' | 'hy-mt2-7b', name: id, purpose: id, bytes: 100, version: '1',
    selectedVariant: `${id}-${id === 'kotoba' ? 'q5_0' : 'q4_k_m'}`, installed: true, inUse: false,
    variants: [id === 'kotoba' ? 'q5_0' : 'q4_k_m', id === 'qwen3' ? 'q6_k' : 'q8_0'].map((precision, index) => ({
      id: `${id}-${precision}`, precision, publisher: 'publisher', format: id === 'kotoba' ? 'GGML' as const : 'GGUF' as const,
      bytes: 100, recommended: index === 0, installed: index === 0, inUse: false, source: 'https://example.invalid',
      ready: index === 0, readiness: index === 0 ? 'ready' as const : 'missing-model' as const, references: []
    }))
  }))
}
let state = structuredClone(original)
let changed: (state: LocalModelSnapshot) => void = () => {}
const commands: LocalModelCommand[] = []
let getManagement = async (): Promise<never> => { throw new Error('提供商配置读取失败') }
const fake = { settings: {
  getModelManagement: () => getManagement(),
  getLocalModels: async () => state,
  onLocalModelsChanged: (listener: typeof changed) => { changed = listener; return () => {} },
  localModelCommand: async (command: LocalModelCommand) => {
    commands.push(command)
    if (command.action === 'usage') {
      assert.equal(command.expectedRevision, state.revision, 'usage saves must use the latest revision')
      state = { ...state, usage: command.usage, revision: `r${Number(state.revision.slice(1)) + 1}`, configurationError: null }
      changed(state)
    }
    return state
  }
} } as unknown as ElectronApi
Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), {
  api: fake, location: { href: 'http://localhost/' }, history: { state: null, pushState() {}, go() {} }, setTimeout, clearTimeout
}) })
Object.defineProperty(globalThis, 'document', { configurable: true, value: { body: { style: {} }, activeElement: null } })
let renderer: TestRenderer.ReactTestRenderer | undefined
let router: ReturnType<typeof createMemoryRouter> | undefined
afterEach(() => {
  act(() => renderer?.unmount()); router?.dispose(); commands.length = 0; state = structuredClone(original)
  getManagement = async () => { throw new Error('提供商配置读取失败') }
})
async function mount(fullPanel = false, options?: TestRenderer.TestRendererOptions, entry = '/settings/models/usage'): Promise<void> {
  const Panel = (await import('./LocalModelUsagePanel')).default
  const ModelPanel = fullPanel ? (await import('./ModelSettingsPanel')).default : null
  const settings = { llmSecretStorage: { protection: 'secure' } } as SettingsSnapshot
  router = createMemoryRouter([{ path: '*', element:
    <OverlayHistoryProvider><NavigationGuardProvider><SettingsLeaveGuard>{ModelPanel
      ? <ModelPanel activeTab="usage" settings={settings} /> : <Panel />}</SettingsLeaveGuard></NavigationGuardProvider></OverlayHistoryProvider>
  }], { initialEntries: [entry] })
  await act(async () => { renderer = TestRenderer.create(<RouterProvider router={router!} />, options) })
}

test('subtitle anchor waits for preceding model configuration and scrolls only the settings body', async () => {
  let fail!: (error: Error) => void
  getManagement = () => new Promise((_resolve, reject) => { fail = reject })
  const scroller = { scrollTop: 40, getBoundingClientRect: () => ({ top: 100 }) }
  const target = {
    closest: (selector: string) => { assert.equal(selector, '[data-settings-scroll-region]'); return scroller },
    getBoundingClientRect: () => ({ top: 350 }),
    scrollIntoView: () => assert.fail('must not move outer scroll containers')
  }
  await mount(true, { createNodeMock: node => node.type === 'div' ? { querySelector: () => target } : null }, '/settings/models/usage#ai-subtitles')
  assert.equal(scroller.scrollTop, 40, 'local model data alone must not trigger an early jump')
  await act(async () => fail(new Error('提供商配置读取失败')))
  assert.equal(scroller.scrollTop, 290, 'provider failure still settles the preceding layout and permits positioning')
})
async function choose(label: string, value: string): Promise<void> {
  const Select = (await import('../SelectControl')).default
  const input = renderer!.root.findAllByType(Select).find(item => item.props['aria-label'] === label)!
  act(() => input.props.onChange({ target: { value } }))
}
function subtitleSave(): TestRenderer.ReactTestInstance {
  return renderer!.root.findByProps({ id: 'ai-subtitles' }).findAllByType('button')
    .find(item => renderedText(item) === '保存')!
}
test('subtitle model draft survives targeted file navigation, remains independent of text use, and saves exact precision', async () => {
  await mount()
  await choose('字幕翻译模型', 'hy-mt2-7b')
  await choose('字幕翻译精度与发布者', 'hy-mt2-7b-q8_0')
  assert.equal(commands.length, 0)
  const download = renderer!.root.findAllByType('button').find(item => renderedText(item) === '前往下载')!
  await act(async () => download.props.onClick())
  assert.equal(router!.state.location.pathname, '/settings/models/local')
  assert.match(router!.state.location.search, /variant=hy-mt2-7b-q8_0/)
  assert.equal(renderer!.root.findAllByProps({ role: 'dialog' }).length, 0)
  await act(async () => { await router!.navigate('/settings/models/usage') })
  const save = subtitleSave()
  await act(async () => save.props.onClick())
  assert.deepEqual(commands, [{ action: 'usage', expectedRevision: 'r1', usage: {
    ...original.usage, subtitleTranslation: { model: 'hy-mt2-7b', variant: 'hy-mt2-7b-q8_0' }
  } }])
})
test('leaving the model group still protects an unsaved local usage draft', async () => {
  await mount()
  await choose('文本翻译模型来源', 'local')
  await act(async () => { await router!.navigate('/settings/about/info') })
  assert.equal(router!.state.location.pathname, '/settings/models/usage')
  assert.equal(renderer!.root.findAllByProps({ role: 'dialog' }).length, 1)
})

test('save before leaving preserves both local purpose drafts using successive revisions', async () => {
  await mount()
  await choose('字幕翻译精度与发布者', 'qwen3-q6_k')
  await choose('文本翻译模型来源', 'local')
  await act(async () => { await router!.navigate('/settings/about/info') })
  const save = renderer!.root.findAllByType('button').find(item => renderedText(item) === '保存后离开')!
  await act(async () => save.props.onClick())
  assert.equal(router!.state.location.pathname, '/settings/about/info')
  assert.deepEqual(state.usage, {
    ...original.usage,
    subtitleTranslation: { model: 'qwen3', variant: 'qwen3-q6_k' },
    textTranslation: { ...original.usage.textTranslation, mode: 'local' }
  })
  assert.deepEqual(commands.map(command => command.action === 'usage' ? command.expectedRevision : null), ['r1', 'r2'])
})
test('old advanced route resolves to providers and only retained model tabs bypass draft leave protection', () => {
  assert.equal(resolveSettingsRoute('/settings/models/advanced').tab, 'providers')
  assert.equal(settingsPath('models', 'advanced'), '/settings/models/providers')
  assert.equal(preservesModelUsageDraft('/settings/models/local'), true)
  assert.equal(preservesModelUsageDraft('/settings/appearance/theme'), false)
})
test('local purpose settings remain editable when provider configuration cannot be read', async () => {
  await mount(true)
  assert.equal(renderer!.root.findAllByType('h3').some(item => item.children.includes('AI 字幕')), true)
  assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).some(item => item.children.some(child =>
    typeof child !== 'string' && child.children.includes('提供商配置读取失败'))), true)
  await choose('字幕翻译精度与发布者', 'qwen3-q6_k')
  const save = subtitleSave()
  assert.equal(save.props.disabled, false)
  await act(async () => save.props.onClick())
  assert.equal(commands[0]?.action, 'usage')
})
test('file operations disable usage saves without discarding editable drafts', async () => {
  state = { ...state, operation: 'download', activeModel: 'qwen3', activeVariant: 'qwen3-q6_k' }
  await mount()
  await choose('字幕翻译精度与发布者', 'qwen3-q6_k')
  const save = subtitleSave()
  assert.equal(save.props.disabled, true)
  assert.equal(commands.length, 0)
})
test('invalid persisted usage can be explicitly repaired even without an edited draft', async () => {
  state = { ...state, configurationError: '字幕翻译精度与模型不匹配' }
  await mount()
  const recover = renderer!.root.findAllByType('button').find(item => renderedText(item) === '恢复用途配置')!
  assert.equal(recover.props.disabled, false)
  await act(async () => recover.props.onClick())
  assert.deepEqual(commands, [{ action: 'usage', expectedRevision: 'r1', usage: original.usage }])
  assert.equal(renderer!.root.findAllByType('button').some(item => renderedText(item) === '恢复用途配置'), false)
})
