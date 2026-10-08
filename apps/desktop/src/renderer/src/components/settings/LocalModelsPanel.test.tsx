import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import TestRenderer, { act } from 'react-test-renderer'
import type { LocalModelCommand, LocalModelSnapshot, LocalModelView } from '@shared/desktop/localModels'
import type { ElectronApi } from '../../../../preload/index'
import { OverlayHistoryProvider } from '../../interaction/OverlayHistoryContext'
import FloatingLayer from '../FloatingLayer'
import Modal from '../Modal'
import Button from '../Button'
import { renderedText } from '../../test/renderedText'

function family(id: LocalModelView['id'], name: string, publisher: string, bytes: number): LocalModelView {
  return { id, name, version: name, purpose: id === 'kotoba' ? '日语语音转写' : '本地文本翻译', bytes, installed: true, inUse: false,
    selectedVariant: `${id}-q4_k_m`, variants: [
      { id: `${id}-q4_k_m`, precision: 'Q4_K_M', format: id === 'kotoba' ? 'GGML' : 'GGUF', bytes, installed: true, inUse: false,
        recommended: true, publisher, source: `https://huggingface.co/${publisher}/${name}`, references: [], ready: true, readiness: 'ready' },
      { id: `${id}-q8_0`, precision: 'Q8_0', format: id === 'kotoba' ? 'GGML' : 'GGUF', bytes: bytes * 2, installed: false, inUse: false,
        recommended: false, publisher, source: `https://huggingface.co/${publisher}/${name}`, references: [], ready: false, readiness: 'missing-model' }
    ] }
}
function snapshot(): LocalModelSnapshot {
  const qwen = family('qwen3', 'Qwen3 1.7B', 'bartowski', 1280000000)
  qwen.variants.push({ ...qwen.variants[0], id: 'qwen3-official-q8_0', precision: 'Q8_0', publisher: 'Qwen', recommended: false,
    source: 'https://huggingface.co/Qwen/Qwen3-1.7B-GGUF' })
  return { revision: 'r1', usage: {
    subtitleRecognition: { model: 'kotoba', variant: 'kotoba-q4_k_m' }, subtitleTranslation: { model: 'qwen3', variant: 'qwen3-q4_k_m' },
    textTranslation: { model: 'qwen3', variant: 'qwen3-q4_k_m', mode: 'app-default' }
  }, downloadSource: 'official', supported: true, directory: '/models', defaultDirectory: '/models', translation: 'app-default', translationModel: 'qwen3',
    operation: null, activeModel: null, activeVariant: null, downloadBytes: 0, downloadTotal: 0, downloadLabel: null, error: null,
    models: [qwen, family('kotoba', 'Kotoba v2.0', 'kotoba-tech', 1520000000), family('hy-mt2-7b', 'HY-MT2 7B', 'tencent', 4624648896),
      family('index-translate-9b', 'Index-Translate 9B', 'IndexTeam', 5780090304)] }
}
let state = snapshot()
let changed: (value: LocalModelSnapshot) => void = () => {}
let read = async (): Promise<LocalModelSnapshot> => state
let command = async (): Promise<LocalModelSnapshot> => state
const commands: LocalModelCommand[] = []
const fake = { settings: {
  getLocalModels: () => read(),
  onLocalModelsChanged: (listener: typeof changed) => { changed = listener; return () => { changed = () => {} } },
  localModelCommand: (value: LocalModelCommand) => { commands.push(value); return command() }
} } as unknown as ElectronApi
Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), {
  api: fake, location: { href: 'http://localhost/' }, history: { state: null, pushState() {}, go() {} }, setTimeout, clearTimeout
}) })
Object.defineProperty(globalThis, 'document', { configurable: true, value: { body: { style: { overflow: '' } }, activeElement: null } })
let renderer: TestRenderer.ReactTestRenderer | undefined
let Select: typeof import('../SelectControl').default
let currentLocation = ''
function LocationProbe(): null {
  const location = useLocation(); currentLocation = location.pathname + location.search + location.hash; return null
}
async function mount(path = '/settings/models/local'): Promise<void> {
  const Panel = (await import('./LocalModelsPanel')).default
  Select = (await import('../SelectControl')).default
  await act(async () => { renderer = TestRenderer.create(<MemoryRouter initialEntries={[path]}><OverlayHistoryProvider><Panel /><LocationProbe /></OverlayHistoryProvider></MemoryRouter>) })
}
function select(label: string) {
  const result = renderer!.root.findAllByType(Select).find(node => node.props['aria-label'] === label)
  assert.ok(result, label); return result
}
function button(label: string, root = renderer!.root) {
  const result = root.findAllByType('button').find(node => renderedText(node) === label || node.props['aria-label'] === label)
    // Hidden feedback placeholders are not accessible labels, but their layout contract is still inspected.
    ?? root.findAllByType(Button).find(node => node.props['aria-hidden'] === true && node.props.children === label)?.findByType('button')
  assert.ok(result, label); return result
}
function row(variant: string) {
  const result = renderer!.root.findAllByProps({ 'data-variant': variant })[0]; assert.ok(result, variant); return result
}
// Inspect the canonical floating menu's declarative children without a DOM portal in this renderer.
function menuItem(variant: string, label: string): React.ReactElement {
  const menu = row(variant).findByType(FloatingLayer)
  const items = React.Children.toArray(menu.props.children.props.children) as React.ReactElement[]
  const result = items.find(item => item.props.children === label); assert.ok(result, label); return result
}
async function expand(name = 'Qwen3 1.7B'): Promise<void> {
  await act(async () => button(`${name} 管理精度`).props.onClick())
}
async function all(name = 'Qwen3 1.7B'): Promise<void> {
  await act(async () => select(`${name} 精度范围`).props.onChange({ target: { value: 'all' } }))
}
afterEach(async () => {
  await act(async () => renderer?.unmount()); renderer = undefined
  commands.length = 0; state = snapshot(); read = command = async () => state
})

test('local models separate speech and text modalities, keep families compact, and do not expose usage selectors', async () => {
  await mount()
  const speech = renderer!.root.findAllByType('section').find(node => node.props['aria-label'] === '语音输入 → 文本')!
  const text = renderer!.root.findAllByType('section').find(node => node.props['aria-label'] === '文本输入 → 文本')!
  assert.equal(speech.findAllByType('article').length, 1)
  assert.equal(text.findAllByType('article').length, 3)
  assert.equal(renderer!.root.findAllByProps({ role: 'table' }).length, 0)
  const labels = renderer!.root.findAllByType(Select).map(node => node.props['aria-label'])
  assert.deepEqual(labels, ['模型文件范围', '模型下载来源'])
})

test('precision browsing retains exact publisher identity and downloads never change usage', async () => {
  await mount(); await expand()
  assert.ok(row('qwen3-official-q8_0'))
  assert.equal(renderer!.root.findAllByProps({ 'data-variant': 'qwen3-q8_0' }).length, 0)
  await all()
  assert.equal(commands.length, 0)
  await act(async () => button('下载模型', row('qwen3-q8_0')).props.onClick())
  assert.deepEqual(commands, [{ action: 'download', model: 'qwen3', variant: 'qwen3-q8_0' }])
  assert.equal(state.usage.subtitleTranslation.variant, 'qwen3-q4_k_m')
})

test('copy, import and export carry the exact precision and publisher with clipboard feedback', async () => {
  await mount(); await expand()
  for (const label of ['复制下载地址', '导入模型文件', '导出模型文件']) {
    await act(async () => menuItem('qwen3-official-q8_0', label).props.onClick())
  }
  assert.deepEqual(commands, ['copy-download-url', 'import', 'export'].map(action => ({ action, model: 'qwen3', variant: 'qwen3-official-q8_0' })))
  await act(async () => menuItem('qwen3-official-q8_0', '复制下载地址').props.onClick())
  assert.ok(JSON.stringify(renderer!.toJSON()).includes('下载地址已复制'))
  await act(async () => changed({ ...state, operation: 'import' }))
  assert.equal(menuItem('qwen3-official-q8_0', '导入模型文件').props.disabled, true)
  assert.ok(JSON.stringify(renderer!.toJSON()).includes('正在复制并校验模型文件'))
})

test('deletion confirms the exact precision and excludes referenced or running files', async () => {
  state.models[0].variants[0].references = ['字幕翻译']
  await mount(); await expand()
  assert.equal(menuItem('qwen3-q4_k_m', '删除此精度').props.disabled, true)
  await act(async () => menuItem('qwen3-official-q8_0', '删除此精度').props.onClick())
  assert.equal(commands.length, 0)
  assert.equal(renderer!.root.findByType(Modal).props.confirmDisabled, false)
  await act(async () => renderer!.root.findByType(Modal).props.onConfirm())
  assert.deepEqual(commands, [{ action: 'delete', model: 'qwen3', variant: 'qwen3-official-q8_0' }])
  assert.equal(renderer!.root.findAllByType(Modal).length, 0)
})

test('a reference arriving while deletion confirmation is open disables the confirmation', async () => {
  await mount(); await expand()
  await act(async () => menuItem('qwen3-official-q8_0', '删除此精度').props.onClick())
  const newer = structuredClone(state); newer.models[0].variants[2].references = ['文本翻译']
  await act(async () => changed(newer))
  assert.equal(renderer!.root.findByType(Modal).props.confirmDisabled, true)
})

test('installed-only browsing omits missing files and supplies a compact empty state', async () => {
  await mount(); await expand()
  await act(async () => select('模型文件范围').props.onChange({ target: { value: 'installed' } }))
  assert.equal(renderer!.root.findAllByProps({ 'data-variant': 'qwen3-q8_0' }).length, 0)
  const empty = structuredClone(state); empty.models.forEach(model => model.variants.forEach(variant => { variant.installed = false }))
  await act(async () => changed(empty))
  assert.equal(renderer!.root.findAllByType('article').length, 0)
  assert.ok(JSON.stringify(renderer!.toJSON()).includes('尚未下载此模态的模型精度'))
})

test('targeted installation expands and highlights a missing nonrecommended precision, with a return route preserving scope', async () => {
  await mount('/settings/models/local?scope=library&model=index-translate-9b&variant=index-translate-9b-q8_0')
  assert.equal(row('index-translate-9b-q8_0').props['data-target'], true)
  assert.equal(renderer!.root.findAllByProps({ role: 'table' }).length, 1)
  await act(async () => button('返回用途配置').props.onClick())
  assert.equal(currentLocation, '/settings/models/usage?scope=library#ai-subtitles')
})

test('runtime readiness stays distinct from installed weights on unsupported and incomplete platforms', async () => {
  state.supported = false; state.models[0].variants[0].ready = false; state.models[0].variants[0].readiness = 'unsupported'
  await mount(); await expand()
  assert.equal(button('校验与修复', row('qwen3-q4_k_m')).props.disabled, false)
  assert.ok(JSON.stringify(renderer!.toJSON()).includes('仅管理文件'))
  const incomplete = structuredClone(state); incomplete.supported = true; incomplete.models[0].variants[0].readiness = 'missing-runtime'
  await act(async () => changed(incomplete))
  assert.ok(JSON.stringify(renderer!.toJSON()).includes('需补齐运行依赖'))
})

test('duplicate commands are excluded synchronously and newer events win over command responses', async () => {
  let finish!: (value: LocalModelSnapshot) => void
  command = () => new Promise(resolve => { finish = resolve })
  await mount(); await expand()
  const click = button('校验与修复', row('qwen3-q4_k_m')).props.onClick
  await act(async () => { click(); click() })
  assert.equal(commands.length, 1)
  const newer = structuredClone(state); newer.directory = '/newer-event'
  await act(async () => changed(newer))
  await act(async () => finish(state))
  assert.ok(JSON.stringify(renderer!.toJSON()).includes('/newer-event'))
})

test('an initial read completing after an event does not replace newer state', async () => {
  let finish!: (value: LocalModelSnapshot) => void
  read = () => new Promise(resolve => { finish = resolve })
  await mount()
  const newer = structuredClone(state); newer.directory = '/event-directory'
  await act(async () => changed(newer))
  await act(async () => finish(state))
  assert.ok(JSON.stringify(renderer!.toJSON()).includes('/event-directory'))
})

test('downloading retains precision browsing, copy links and stable actions while excluding conflicting mutations', async () => {
  state.operation = 'download'; state.activeModel = 'qwen3'; state.activeVariant = 'qwen3-q4_k_m'
  await mount(); await expand(); await all()
  assert.equal(select('Qwen3 1.7B 精度范围').props.disabled, undefined)
  assert.equal(menuItem('qwen3-q8_0', '复制下载地址').props.disabled, false)
  assert.equal(menuItem('qwen3-q8_0', '导入模型文件').props.disabled, true)
  assert.equal(button('下载模型', row('qwen3-q8_0')).props.disabled, true)
  assert.equal(button('校验与修复', row('qwen3-q4_k_m')).props['aria-busy'], true)
  assert.equal(button('取消下载').props.disabled, false)
  await act(async () => menuItem('qwen3-q8_0', '复制下载地址').props.onClick())
  assert.ok(JSON.stringify(renderer!.toJSON()).includes('下载地址已复制'))
  await act(async () => button('取消下载').props.onClick())
  assert.deepEqual(commands, [{ action: 'copy-download-url', model: 'qwen3', variant: 'qwen3-q8_0' }, { action: 'cancel-download' }])
})

test('an active text runtime blocks other text repairs while leaving speech repair and precision browsing available', async () => {
  state.models.find(model => model.id === 'index-translate-9b')!.inUse = true
  await mount(); await expand(); await expand('HY-MT2 7B'); await expand('Kotoba v2.0')
  assert.equal(button('校验与修复', row('qwen3-q4_k_m')).props.disabled, true)
  assert.equal(button('校验与修复', row('hy-mt2-7b-q4_k_m')).props.disabled, true)
  assert.equal(button('校验与修复', row('kotoba-q4_k_m')).props.disabled, false)
  assert.equal(select('Qwen3 1.7B 精度范围').props.disabled, undefined)
  assert.equal(button('更改并迁移').props.disabled, true)
})

test('HY and Index expose all catalog precisions, sizes and modalities without selecting uses', async () => {
  await mount(); await expand('HY-MT2 7B'); await all('HY-MT2 7B'); await expand('Index-Translate 9B'); await all('Index-Translate 9B')
  await act(async () => button('下载模型', row('hy-mt2-7b-q8_0')).props.onClick())
  await act(async () => button('下载模型', row('index-translate-9b-q8_0')).props.onClick())
  assert.deepEqual(commands, [ { action: 'download', model: 'hy-mt2-7b', variant: 'hy-mt2-7b-q8_0' },
    { action: 'download', model: 'index-translate-9b', variant: 'index-translate-9b-q8_0' } ])
  const rendered = JSON.stringify(renderer!.toJSON())
  const size = row('index-translate-9b-q4_k_m').findAllByType('span').find(node => node.children.join('') === '5.78 GB')
  assert.ok(size)
  assert.ok(rendered.includes('不接收语音、图片或视频'))
})

test('download source is saved immediately and locked while a download is running', async () => {
  await mount()
  await act(async () => select('模型下载来源').props.onChange({ target: { value: 'hf-mirror' } }))
  assert.deepEqual(commands, [{ action: 'download-source', source: 'hf-mirror' }])
  await act(async () => changed({ ...state, downloadSource: 'hf-mirror', operation: 'download' }))
  assert.equal(select('模型下载来源').props.value, 'hf-mirror')
  assert.equal(select('模型下载来源').props.disabled, true)
})

test('long operation errors stay in the stable feedback row and full detail is keyboard accessible', async () => {
  const detail = '无法写入模型目录：' + '/very-long-path'.repeat(20)
  command = async () => { throw new Error(detail) }
  await mount(); await expand()
  const before = button('错误详情').props.className
  assert.equal(button('错误详情').props.tabIndex, -1)
  await act(async () => button('校验与修复', row('qwen3-q4_k_m')).props.onClick())
  assert.equal(button('错误详情').props.className, before)
  assert.equal(button('错误详情').props.tabIndex, 0)
  assert.equal(JSON.stringify(renderer!.toJSON()).includes(detail), false)
  await act(async () => button('错误详情').props.onClick())
  assert.ok(JSON.stringify(renderer!.toJSON()).includes(detail))
})

for (const failedAction of ['download', 'import'] as const) {
  test(`successful copy after failed ${failedAction} acknowledges only the historical snapshot error`, async () => {
    await mount(); await expand()
    command = async () => {
      state = { ...state, error: '上次模型操作失败' }; changed(state)
      throw new Error('上次失败的技术明细')
    }
    await act(async () => failedAction === 'download'
      ? button('校验与修复', row('qwen3-q4_k_m')).props.onClick()
      : menuItem('qwen3-q4_k_m', '导入模型文件').props.onClick())
    assert.equal(button('错误详情').props.tabIndex, 0)
    command = async () => state // Copy does not clear the manager's historical error.
    await act(async () => menuItem('qwen3-q4_k_m', '复制下载地址').props.onClick())
    assert.ok(JSON.stringify(renderer!.toJSON()).includes('下载地址已复制'))
    assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).length, 0)
    assert.equal(button('错误详情').props.tabIndex, -1)
    await act(async () => changed({ ...state }))
    assert.equal(button('错误详情').props.tabIndex, -1, 'repeated idle snapshots must not resurrect the same historical failure')
    await act(async () => changed({ ...state, operation: 'download', error: null }))
    assert.ok(JSON.stringify(renderer!.toJSON()).includes('模型下载进度'))
    await act(async () => changed({ ...state, operation: null }))
    assert.equal(button('错误详情').props.tabIndex, 0, 'a new failed operation with the same message must remain visible')
    assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).length, 1)
  })
}

test('a newer operation failure arriving during successful copy retains the current error', async () => {
  state.error = '下载校验失败'
  let finish!: (value: LocalModelSnapshot) => void
  command = () => new Promise(resolve => { finish = resolve })
  await mount(); await expand()
  await act(async () => menuItem('qwen3-q4_k_m', '复制下载地址').props.onClick())
  await act(async () => changed({ ...state, operation: 'download', error: null }))
  await act(async () => changed({ ...state, operation: null }))
  await act(async () => finish(state))
  assert.equal(button('错误详情').props.tabIndex, 0)
  assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).length, 1)
  assert.ok(JSON.stringify(renderer!.toJSON()).includes('操作失败，请查看错误详情'))
})
