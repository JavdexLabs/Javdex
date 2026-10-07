import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import TestRenderer, { act } from 'react-test-renderer'
import type { LocalModelCommand, LocalModelSnapshot } from '@shared/desktop/localModels'
import type { ElectronApi } from '../../../../preload/index'
import { OverlayHistoryProvider } from '../../interaction/OverlayHistoryContext'

function snapshot(): LocalModelSnapshot {
  return { supported: true, directory: '/models', defaultDirectory: '/models', translation: 'app-default', translationModel: 'qwen3',
    operation: null, activeModel: null, activeVariant: null, downloadBytes: 0, downloadTotal: 0, downloadLabel: null, error: null,
    models: [{ id: 'qwen3', name: 'Qwen3 1.7B', version: 'Qwen3-1.7B', purpose: '本地翻译', bytes: 100,
      selectedVariant: 'qwen3-q4_k_m', installed: true, inUse: false, variants: [
        { id: 'qwen3-q4_k_m', precision: 'Q4_K_M', format: 'GGUF', bytes: 100, installed: true, inUse: false,
          recommended: true, publisher: 'bartowski', source: 'https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF' },
        { id: 'qwen3-q8_0', precision: 'Q8_0', format: 'GGUF', bytes: 200, installed: false, inUse: false,
          recommended: false, publisher: 'bartowski', source: 'https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF' },
        { id: 'qwen3-official-q8_0', precision: 'Q8_0', format: 'GGUF', bytes: 250, installed: true, inUse: false,
          recommended: false, publisher: 'Qwen', source: 'https://huggingface.co/Qwen/Qwen3-1.7B-GGUF' }
      ] }] }
}
function addHy(installed = true): void {
  state.models.push({ id: 'hy-mt2-7b', name: 'HY-MT2 7B', version: 'Hy-MT2-7B', purpose: '本地翻译', bytes: 4624648896,
    selectedVariant: 'hy-mt2-7b-q4_k_m', installed, inUse: false, variants: [
      { id: 'hy-mt2-7b-q4_k_m', precision: 'Q4_K_M', format: 'GGUF', bytes: 4624648896, installed, inUse: false,
        recommended: true, publisher: 'tencent', source: 'https://huggingface.co/tencent/Hy-MT2-7B-GGUF' },
      { id: 'hy-mt2-7b-q6_k', precision: 'Q6_K', format: 'GGUF', bytes: 6164482720, installed: false, inUse: false,
        recommended: false, publisher: 'tencent', source: 'https://huggingface.co/tencent/Hy-MT2-7B-GGUF' },
      { id: 'hy-mt2-7b-q8_0', precision: 'Q8_0', format: 'GGUF', bytes: 7981928896, installed: false, inUse: false,
        recommended: false, publisher: 'tencent', source: 'https://huggingface.co/tencent/Hy-MT2-7B-GGUF' }
    ] })
}
function addIndex(installed = true): void {
  state.models.push({ id: 'index-translate-9b', name: 'Index-Translate 9B', version: 'Index-Translate-9B', purpose: '本地翻译', bytes: 5780090304,
    selectedVariant: 'index-translate-9b-q4_k_m', installed, inUse: false, variants: [
      { id: 'index-translate-9b-q4_k_m', precision: 'Q4_K_M', format: 'GGUF', bytes: 5780090304, installed, inUse: false,
        recommended: true, publisher: 'IndexTeam', source: 'https://huggingface.co/IndexTeam/Index-Translate-9B-GGUF' },
      { id: 'index-translate-9b-q8_0', precision: 'Q8_0', format: 'GGUF', bytes: 9786060224, installed: false, inUse: false,
        recommended: false, publisher: 'IndexTeam', source: 'https://huggingface.co/IndexTeam/Index-Translate-9B-GGUF' },
      { id: 'index-translate-9b-f16', precision: 'F16', format: 'GGUF', bytes: 18407321024, installed: false, inUse: false,
        recommended: false, publisher: 'IndexTeam', source: 'https://huggingface.co/IndexTeam/Index-Translate-9B-GGUF' }
    ] })
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
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
  body: { style: { overflow: '' } }, activeElement: null
} })
let renderer: TestRenderer.ReactTestRenderer | undefined
let Select: typeof import('../SelectControl').default
async function mount(): Promise<void> {
  const Panel = (await import('./LocalModelsPanel')).default
  Select = (await import('../SelectControl')).default
  await act(async () => { renderer = TestRenderer.create(<MemoryRouter><OverlayHistoryProvider><Panel /></OverlayHistoryProvider></MemoryRouter>) })
}
function select(label: string) {
  const result = renderer!.root.findAllByType(Select).find(node => node.props['aria-label'] === label)
  assert.ok(result, label); return result
}
function button(label: string) {
  const result = renderer!.root.findAllByType('button').find(node => node.children.includes(label))
  assert.ok(result, label); return result
}
afterEach(async () => {
  await act(async () => renderer?.unmount()); renderer = undefined
  commands.length = 0; state = snapshot(); read = command = async () => state
})

test('browsing precisions does not switch the active model, and downloads carry the exact selected catalog identity', async () => {
  await mount()
  const options = React.Children.toArray(select('Qwen3 1.7B 查看精度').props.children) as React.ReactElement[]
  assert.deepEqual(options.map(item => item.props.value), ['qwen3-q4_k_m', 'qwen3-q8_0', 'qwen3-official-q8_0'])
  await act(async () => select('Qwen3 1.7B 查看精度').props.onChange({ target: { value: 'qwen3-q8_0' } }))
  assert.deepEqual(commands, [])
  assert.equal(button('使用此精度').props.disabled, true)
  await act(async () => button('下载模型').props.onClick())
  assert.deepEqual(commands, [{ action: 'download', model: 'qwen3', variant: 'qwen3-q8_0' }])
  assert.ok(JSON.stringify(renderer!.toJSON()).includes('当前选择：'))
  assert.equal(state.models[0].selectedVariant, 'qwen3-q4_k_m')
})

test('switch, deletion and export address an installed precision explicitly, including a second publisher of the same precision', async () => {
  await mount()
  await act(async () => select('Qwen3 1.7B 查看精度').props.onChange({ target: { value: 'qwen3-official-q8_0' } }))
  assert.equal(button('使用此精度').props.disabled, false)
  await act(async () => button('使用此精度').props.onClick())
  await act(async () => button('导出模型').props.onClick())
  await act(async () => button('删除此精度').props.onClick())
  assert.deepEqual(commands, ['select', 'export', 'delete'].map(action => ({ action, model: 'qwen3', variant: 'qwen3-official-q8_0' })))
})

test('installed-only filter retains installed variants and gives an actionable empty state', async () => {
  await mount()
  await act(async () => select('模型商店范围').props.onChange({ target: { value: 'installed' } }))
  assert.deepEqual((React.Children.toArray(select('Qwen3 1.7B 查看精度').props.children) as React.ReactElement[]).map(item => item.props.value),
    ['qwen3-q4_k_m', 'qwen3-official-q8_0'])
  const empty = snapshot(); empty.models[0].installed = false
  empty.models[0].variants.forEach(item => { item.installed = false })
  await act(async () => changed(empty))
  assert.equal(renderer!.root.findAllByType('article').length, 0)
  assert.ok(JSON.stringify(renderer!.toJSON()).includes('尚未下载模型精度'))
})

test('model file management remains available on unsupported runtime platforms without offering local inference', async () => {
  state.supported = false
  await mount()
  assert.equal(button('校验与修复').props.disabled, false)
  const options = React.Children.toArray(select('AI 文本翻译模型来源').props.children) as React.ReactElement[]
  assert.equal(options.find(item => item.props.value === 'local')!.props.disabled, true)
  assert.ok(JSON.stringify(renderer!.toJSON()).includes('下载不代表能在其他平台运行'))
})

test('commands synchronously exclude duplicate clicks and stale command results cannot overwrite newer model events', async () => {
  let finish!: (value: LocalModelSnapshot) => void
  command = () => new Promise(resolve => { finish = resolve })
  await mount()
  const click = button('校验与修复').props.onClick
  await act(async () => { click(); click() })
  assert.equal(commands.length, 1)
  const newer = snapshot(); newer.models[0].selectedVariant = 'qwen3-official-q8_0'
  await act(async () => changed(newer))
  await act(async () => finish(state))
  assert.equal(select('Qwen3 1.7B 查看精度').props.value, 'qwen3-official-q8_0')
  assert.equal(button('使用此精度').props.disabled, true)
})

test('usage and operation snapshots disable conflicting mutations while retaining non-mutating browsing', async () => {
  state.models[0].inUse = true
  await mount()
  assert.equal(button('更改并迁移').props.disabled, true)
  assert.equal(button('校验与修复').props.disabled, true)
  assert.equal(button('删除此精度').props.disabled, true)
  assert.equal(select('Qwen3 1.7B 查看精度').props.disabled, false)
  await act(async () => changed({ ...state, operation: 'download', activeModel: 'qwen3', activeVariant: 'qwen3-q4_k_m' }))
  assert.equal(select('Qwen3 1.7B 查看精度').props.disabled, true)
  assert.equal(button('取消下载').props.disabled, false)
})

test('HY catalog browsing and downloads do not switch the active translator; family selection is an explicit independent command', async () => {
  addHy()
  await mount()
  const options = React.Children.toArray(select('HY-MT2 7B 查看精度').props.children) as React.ReactElement[]
  assert.deepEqual(options.map(item => item.props.value), ['hy-mt2-7b-q4_k_m', 'hy-mt2-7b-q6_k', 'hy-mt2-7b-q8_0'])
  await act(async () => select('HY-MT2 7B 查看精度').props.onChange({ target: { value: 'hy-mt2-7b-q6_k' } }))
  assert.deepEqual(commands, [])
  assert.equal(select('本地翻译模型').props.value, 'qwen3')
  const article = renderer!.root.findAllByType('article').find(node => node.props['aria-label'] === 'HY-MT2 7B 模型精度')!
  const download = article.findAllByType('button').find(node => node.children.includes('下载模型'))!
  await act(async () => download.props.onClick())
  assert.deepEqual(commands, [{ action: 'download', model: 'hy-mt2-7b', variant: 'hy-mt2-7b-q6_k' }])
  await act(async () => select('本地翻译模型').props.onChange({ target: { value: 'hy-mt2-7b' } }))
  assert.deepEqual(commands[1], { action: 'translation-model', model: 'hy-mt2-7b' })
  assert.equal(select('AI 文本翻译模型来源').props.value, 'app-default')
  assert.ok(JSON.stringify(renderer!.toJSON()).includes('文件大小不是运行内存需求'))
})

test('local text availability follows HY rather than an installed Qwen, and shared repairs are disabled during active translation', async () => {
  addHy(false); state.translationModel = 'hy-mt2-7b'
  await mount()
  const sourceOptions = React.Children.toArray(select('AI 文本翻译模型来源').props.children) as React.ReactElement[]
  assert.equal(sourceOptions.find(item => item.props.value === 'local')!.props.disabled, true)
  const families = React.Children.toArray(select('本地翻译模型').props.children) as React.ReactElement[]
  assert.equal(families.find(item => item.props.value === 'hy-mt2-7b')!.props.disabled, true)
  const used = structuredClone(state)
  used.models[1].installed = true; used.models[1].inUse = true
  await act(async () => changed(used))
  assert.equal(select('本地翻译模型').props.disabled, true)
  assert.equal(button('校验与修复').props.disabled, true, 'Qwen repair would touch the shared translator executable')
  assert.equal(select('HY-MT2 7B 查看精度').props.disabled, false, 'non-mutating browsing remains available')
})

test('Index precision browsing and downloads preserve the active family until an explicit family selection', async () => {
  addIndex()
  await mount()
  const options = React.Children.toArray(select('Index-Translate 9B 查看精度').props.children) as React.ReactElement[]
  assert.deepEqual(options.map(item => item.props.value), ['index-translate-9b-q4_k_m', 'index-translate-9b-q8_0', 'index-translate-9b-f16'])
  await act(async () => select('Index-Translate 9B 查看精度').props.onChange({ target: { value: 'index-translate-9b-f16' } }))
  assert.deepEqual(commands, [])
  assert.equal(select('本地翻译模型').props.value, 'qwen3')
  const article = renderer!.root.findAllByType('article').find(node => node.props['aria-label'] === 'Index-Translate 9B 模型精度')!
  assert.equal(article.findAllByType('button').find(node => node.children.includes('使用此精度'))!.props.disabled, true)
  await act(async () => article.findAllByType('button').find(node => node.children.includes('下载模型'))!.props.onClick())
  assert.deepEqual(commands, [{ action: 'download', model: 'index-translate-9b', variant: 'index-translate-9b-f16' }])
  await act(async () => select('本地翻译模型').props.onChange({ target: { value: 'index-translate-9b' } }))
  assert.deepEqual(commands[1], { action: 'translation-model', model: 'index-translate-9b' })
  assert.equal(select('AI 文本翻译模型来源').props.value, 'app-default')
  const rendered = JSON.stringify(renderer!.toJSON())
  assert.ok(rendered.includes('全部 12 档纯文本 GGUF'))
  assert.ok(rendered.includes('不包含视觉附件或语音模型'))
  assert.ok(rendered.includes('许可正文来自官方项目'))
})

test('Index availability follows its selected precision and its lease disables repairs of all shared translators', async () => {
  addHy(); addIndex(false); state.translationModel = 'index-translate-9b'
  await mount()
  const options = React.Children.toArray(select('AI 文本翻译模型来源').props.children) as React.ReactElement[]
  assert.equal(options.find(item => item.props.value === 'local')!.props.disabled, true)
  const families = React.Children.toArray(select('本地翻译模型').props.children) as React.ReactElement[]
  assert.equal(families.find(item => item.props.value === 'index-translate-9b')!.props.disabled, true)
  const used = structuredClone(state)
  const index = used.models.find(model => model.id === 'index-translate-9b')!
  index.installed = true; index.inUse = true
  index.variants.find(variant => variant.id === index.selectedVariant)!.installed = true
  await act(async () => changed(used))
  assert.equal(select('本地翻译模型').props.disabled, true)
  const repairs = renderer!.root.findAllByType('button').filter(node => node.children.includes('校验与修复'))
  assert.equal(repairs.length, 3)
  assert.equal(repairs.every(node => node.props.disabled), true)
  assert.equal(select('Index-Translate 9B 查看精度').props.disabled, false)
})
