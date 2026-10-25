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
import SettingsSwitchRow from '../SettingsSwitchRow'
import { ToastProvider } from '../Toast'
import { renderedText } from '../../test/renderedText'
import { runtimeComponentsFixture, runtimePlanFixture } from '../../test/localRuntimeFixture'

function family(id: LocalModelView['id'], name: string, publisher: string, bytes: number): LocalModelView {
  return { id, name, version: name, purpose: id === 'kotoba' ? '日语语音转写' : '本地文本翻译', bytes, installed: true, inUse: false,
    selectedVariant: `${id}-q4_k_m`, variants: [
      { id: `${id}-q4_k_m`, precision: 'Q4_K_M', format: id === 'kotoba' ? 'GGML' : 'GGUF', bytes, installed: true, inUse: false,
        recommended: true, publisher, source: `https://huggingface.co/${publisher}/${name}`, references: [], ready: true, readiness: 'ready' },
      { id: `${id}-${id === 'qwen3' ? 'q6_k' : 'q8_0'}`, precision: id === 'qwen3' ? 'Q6_K' : 'Q8_0', format: id === 'kotoba' ? 'GGML' : 'GGUF', bytes: bytes * 2, installed: false, inUse: false,
        recommended: false, publisher, source: `https://huggingface.co/${publisher}/${name}`, references: [], ready: false, readiness: 'missing-model' }
    ] }
}
function snapshot(): LocalModelSnapshot {
  const qwen = family('qwen3', 'Qwen3 1.7B', 'bartowski', 1280000000)
  qwen.variants.push({ ...qwen.variants[0], id: 'qwen3-official-q8_0', precision: 'Q8_0', publisher: 'Qwen', recommended: false,
    source: 'https://huggingface.co/Qwen/Qwen3-1.7B-GGUF' })
  const kotoba = family('kotoba', 'Kotoba v2.0', 'kotoba-tech', 1520000000)
  qwen.variants[0].references = ['字幕翻译']
  kotoba.variants[0].references = ['字幕识别']
  return { revision: 'r1', usage: {
    subtitleRecognition: { model: 'kotoba', variant: 'kotoba-q4_k_m' }, subtitleTranslation: { model: 'qwen3', variant: 'qwen3-q4_k_m' },
    textTranslation: { model: 'qwen3', variant: 'qwen3-q4_k_m', mode: 'app-default' }
  }, downloadSource: 'official', supported: true, directory: '/models', defaultDirectory: '/models', translation: 'app-default', translationModel: 'qwen3',
    operation: null, activeModel: null, activeVariant: null, downloadBytes: 0, downloadTotal: 0, downloadLabel: null, error: null,
    models: [qwen, kotoba, family('hy-mt2-7b', 'HY-MT2 7B', 'tencent', 4624648896)] }
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
  await act(async () => { renderer = TestRenderer.create(<MemoryRouter initialEntries={[path]}><OverlayHistoryProvider><ToastProvider><Panel /><LocationProbe /></ToastProvider></OverlayHistoryProvider></MemoryRouter>) })
}
function select(label: string) {
  const result = renderer!.root.findAllByType(Select).find(node => node.props['aria-label'] === label)
  assert.ok(result, label); return result
}
function button(label: string, root = renderer!.root) {
  const buttons = root.findAllByType('button')
  const result = buttons.find(node => renderedText(node) === label || node.props['aria-label'] === label
    || label === '下载模型' && String(node.props['aria-label']).endsWith(' 下载模型'))
  assert.ok(result, label); return result
}
function row(variant: string) {
  const result = renderer!.root.findAllByProps({ 'data-variant': variant })[0]; assert.ok(result, variant); return result
}
// Inspect the canonical floating menu's declarative children without a DOM portal in this renderer.
function menuItem(variant: string, label: string): React.ReactElement {
  const menu = row(variant).findByType(FloatingLayer)
  const items = React.Children.toArray(menu.props.children.props.children) as React.ReactElement[]
  const result = items.find(item => React.Children.toArray(item.props.children).includes(label)); assert.ok(result, label); return result
}
async function expand(name = 'Qwen3 1.7B'): Promise<void> {
  const toggle = button(`${name} 精度列表`)
  if (!toggle.props['aria-expanded']) await act(async () => toggle.props.onClick())
}
afterEach(async () => {
  await act(async () => renderer?.unmount()); renderer = undefined
  commands.length = 0; state = snapshot(); read = command = async () => state
})
function sharedEnvironment(installed = (id: string) => id.endsWith('-cpu') || id.endsWith('-common')) {
  state.acceleration = { supported: true, policy: { mode: 'auto' }, devices: [{ id: 'gpu', name: 'RTX 4080', backend: 'cuda', index: 0, memoryMiB: 16384 }],
    recognition: { backend: 'idle' }, translation: { backend: 'idle' }, error: null, detectionComplete: true }
  const components = runtimeComponentsFixture.map(component => ({ ...component,
    installed: installed(component.id) }))
  state.environments = (['speech', 'text'] as const).map(group => {
    const plan = runtimePlanFixture(group, components, 'cuda')
    return { group, components: components.filter(item => item.group === group), cpuReady: components.filter(item => item.group === group && (item.backend === 'cpu' || item.backend === 'common')).every(item => item.installed),
      gpu: { state: 'missing', backend: 'cuda' }, preparation: plan, gpuPreparation: plan }
  })
}

test('speech models share one section with independent Qwen runtime and ForcedAligner settings', async () => {
  sharedEnvironment()
  const model = family('qwen3-asr', 'Qwen3-ASR 1.7B', 'audio-cpp', 2473010048)
  model.installed = false
  model.variants = [{ ...model.variants[0], id: 'qwen3-asr-q8_0', precision: 'Q8_0', installed: false, ready: false, runtimeReady: false }]
  state.models.push(model)
  const components = [{ ...runtimeComponentsFixture[0], id: 'audiocpp-cpu', group: 'qwen-speech' as const, name: 'audio.cpp 语音引擎', installed: false }]
  const plan = runtimePlanFixture('qwen-speech', components)
  state.environments!.push({ group: 'qwen-speech', supported: true, components, cpuReady: false, gpu: { state: 'missing', backend: 'vulkan' }, preparation: plan, gpuPreparation: plan })
  await mount()
  const first = renderer!.root.findAllByType('section').find(node => node.props['aria-label'] === '语音模型')!
  assert.ok(renderedText(first).includes('Kotoba'))
  assert.ok(renderedText(first).includes('Qwen3-ASR'))
  await expand('Qwen3-ASR 1.7B')
  const second = first.findAllByType('article').find(node => node.props['aria-label'] === 'Qwen3-ASR 1.7B 模型文件')!
  const aligner = () => second.findByType(SettingsSwitchRow)
  assert.equal(aligner().props.checked, true)
  await act(async () => aligner().props.onChange(false))
  assert.deepEqual(commands[0], { action: 'qwen-forced-aligner', enabled: false, expectedRevision: 'r1' })
  state.qwenForcedAligner = false
  await act(async () => changed({ ...state }))
  assert.equal(aligner().props.checked, false)
  await act(async () => button('安装运行环境', second).props.onClick())
  assert.deepEqual(commands[1], { action: 'prepare-runtime', group: 'qwen-speech', target: 'cpu' })
  const active = structuredClone(state); active.models.find(item => item.id === 'qwen3-asr')!.inUse = true
  await act(async () => changed(active))
  assert.equal(aligner().props.disabled, true)
})
for (const group of ['speech', 'text'] as const) test(`${group} environment deletion checks only its own precision files and reacts to live changes`, async () => {
  sharedEnvironment(); await mount()
  const groupName = group === 'speech' ? '语音' : '文本'
  await act(async () => button(`删除${groupName}基础运行环境`).props.onClick())
  assert.equal(renderer!.root.findByType(Modal).props.confirmDisabled, true)
  assert.match(renderedText(renderer!.root.findByType(Modal)), new RegExp(`以下${groupName}模型文件`))
  assert.equal(renderer!.root.findByType(Modal).findAllByType('button').some(node => renderedText(node) === '删除'), false)
  assert.ok(button('查看相关文件', renderer!.root.findByType(Modal)))
  await act(async () => renderer!.root.findByType(Modal).props.onConfirm())
  assert.deepEqual(commands, [])
  const empty = structuredClone(state)
  empty.models.filter(model => (model.id === 'kotoba') === (group === 'speech')).forEach(model => model.variants.forEach(variant => { variant.installed = false; variant.hasFiles = false }))
  await act(async () => changed(empty))
  assert.equal(renderer!.root.findByType(Modal).props.confirmDisabled, false)
  const partial = structuredClone(empty)
  partial.models.find(model => (model.id === 'kotoba') === (group === 'speech'))!.variants[1].hasFiles = true
  await act(async () => changed(partial))
  assert.equal(renderer!.root.findByType(Modal).props.confirmDisabled, true)
  await act(async () => changed(empty))
  await act(async () => renderer!.root.findByType(Modal).props.onConfirm())
  assert.deepEqual(commands, [{ action: 'delete-runtime', group, target: 'cpu' }])
})

test('GPU support deletion includes installed inactive backends and never offers per-component deletion', async () => {
  sharedEnvironment(() => true)
  state.acceleration!.policy = { mode: 'cpu' }
  state.environments!.forEach(item => { item.gpu.state = 'disabled' })
  await mount()
  const gpuRow = renderer!.root.findByProps({ 'aria-label': '文本运行环境' }).findByProps({ 'data-runtime-target': 'gpu' })
  assert.match(renderedText(gpuRow), /当前使用 CPU，GPU 暂不使用.*已安装/)
  assert.doesNotMatch(renderedText(gpuRow), /未启用/)
  await act(async () => button('文本GPU 加速支持组件清单').props.onClick())
  const table = renderer!.root.findByProps({ 'aria-label': '文本GPU 加速支持组件' })
  assert.match(renderedText(table), /CUDA.*VULKAN/)
  assert.equal(table.findAllByType('button').length, 0)
  await act(async () => button('删除文本GPU 加速支持').props.onClick())
  assert.equal(renderer!.root.findByType(Modal).props.confirmDisabled, false)
  assert.match(renderedText(renderer!.root.findByType(Modal)), /基础环境可用时自动使用 CPU/)
  await act(async () => renderer!.root.findByType(Modal).props.onCancel())
  assert.deepEqual(commands, [])
  await act(async () => button('删除文本GPU 加速支持').props.onClick())
  await act(async () => renderer!.root.findByType(Modal).props.onConfirm())
  assert.deepEqual(commands, [{ action: 'delete-runtime', group: 'text', target: 'gpu' }])
})

test('partial files have a filter, resume progress and an exact accessible download target', async () => {
  const partial = state.models[0].variants[1]
  partial.hasFiles = true; partial.preparation = { backend: 'cpu', items: [], downloadBytes: partial.bytes / 2 }
  await mount()
  await act(async () => select('文本模型筛选').props.onChange({ target: { value: 'partial' } }))
  assert.match(renderedText(row(partial.id)), /部分文件.*已下载 50% · 可继续/)
  assert.ok(button(`Qwen3 1.7B Q6_K bartowski 继续下载`, row(partial.id)))
  assert.match(renderedText(button('Qwen3 1.7B 精度列表')), /未完成 1/)
  assert.equal(renderer!.root.findAllByProps({ 'data-variant': 'qwen3-q4_k_m' }).length, 0)
  await act(async () => button('Qwen3 1.7B Q6_K bartowski 继续下载', row(partial.id)).props.onClick())
  assert.deepEqual(commands, [{ action: 'download', model: 'qwen3', variant: partial.id }])
})

test('blocked environment deletion locates its partial files through an incompatible filter', async () => {
  sharedEnvironment()
  state.models.filter(model => model.id !== 'kotoba').forEach(model => model.variants.forEach(variant => { variant.installed = variant.hasFiles = false }))
  state.models[0].variants[1].hasFiles = true
  await mount()
  await act(async () => select('文本模型筛选').props.onChange({ target: { value: 'installed' } }))
  assert.equal(renderer!.root.findAllByProps({ 'data-variant': 'qwen3-q6_k' }).length, 0)
  await act(async () => button('删除文本基础运行环境').props.onClick())
  const modal = renderer!.root.findByType(Modal)
  assert.match(renderedText(modal), /Qwen3 1.7B · Q6_K · bartowski · 部分文件/)
  await act(async () => button('查看相关文件', modal).props.onClick())
  assert.equal(select('文本模型筛选').props.value, 'all')
  assert.equal(row('qwen3-q6_k').props['data-target'], true)
  assert.deepEqual(commands, [])
})

test('asynchronous failures retry their exact precision locally and expose recovery in details', async () => {
  state.error = 'Qwen3 下载连接中断'
  state.operationError = { message: state.error, command: { action: 'download', model: 'qwen3', variant: 'qwen3-q6_k' } }
  state.models[0].variants[1].hasFiles = true
  await mount(); await expand()
  assert.ok(button('Qwen3 1.7B Q6_K bartowski 重试下载', row('qwen3-q6_k')))
  await act(async () => button('重试').props.onClick())
  assert.deepEqual(commands, [state.operationError.command])
})

test('usage navigation returns to text translation without changing bindings', async () => {
  await mount('/settings/models/local?usage=text-translation&model=qwen3&variant=qwen3-q6_k&scope=keep')
  await act(async () => button('返回用途配置').props.onClick())
  assert.equal(currentLocation, '/settings/models/usage?scope=keep#text-translation')
  assert.deepEqual(commands, [])
  await act(async () => menuItem('qwen3-q6_k', '前往用途配置').props.onClick())
  assert.deepEqual(commands, [])
})

test('damaged runtime and partial model files retain deletion controls while active tasks disable environment removal', async () => {
  sharedEnvironment(() => false)
  state.environments![1].components.find(item => item.id === 'translator-cpu')!.hasFiles = true
  state.models[0].variants[1].hasFiles = true
  await mount(); await expand()
  assert.equal(button('删除文本基础运行环境').props.disabled, false)
  assert.equal(menuItem('qwen3-q6_k', '删除此精度').props.disabled, false)
  const active = structuredClone(state); active.models[1].inUse = true
  await act(async () => changed(active))
  assert.equal(button('删除文本基础运行环境').props.disabled, true)
})

test('shared environment inventory belongs to each modality and precision tables omit shared runtime columns', async () => {
  sharedEnvironment(); await mount()
  const text = renderer!.root.findByProps({ 'aria-label': '文本运行环境' })
  await act(async () => button('文本基础运行环境组件清单', text).props.onClick())
  assert.match(renderedText(text), /基础运行环境.*必需.*已安装.*GPU 加速支持.*可选.*未安装/)
  assert.match(renderedText(text), /Qwen3、HY-MT2 的所有精度使用以下组件/)
  assert.doesNotMatch(renderedText(text), /共用运行环境|补齐运行环境|GPU 已验证/)
  assert.equal(renderer!.root.findAllByType('table').filter(table => table.props['aria-label'] === '文本基础运行环境组件').length, 1)
  assert.doesNotMatch(renderedText(row('qwen3-q4_k_m')), /CPU 支持已就绪/)
  const table = renderer!.root.findAllByType('table').find(table => table.props['aria-label'] === 'Qwen3 1.7B 精度列表')!
  assert.equal(table.findAllByProps({ scope: 'col' }).length, 5)
  assert.doesNotMatch(renderedText(table), /当前任务|已选用/)
  assert.doesNotMatch(renderedText(table), /运行支持/)
  await act(async () => button('检查与修复', text).props.onClick())
  await act(async () => button('安装 GPU 加速支持', text).props.onClick())
  assert.deepEqual(commands, [{ action: 'prepare-runtime', group: 'text', target: 'cpu' }, { action: 'prepare-runtime', group: 'text', target: 'gpu' }])
})

test('runtime rows expand their own required components and retain expansion across state changes', async () => {
  sharedEnvironment(id => id.endsWith('-cpu') || id.endsWith('-common') || id.endsWith('-vulkan'))
  await mount()
  const speech = () => renderer!.root.findByProps({ 'aria-label': '语音运行环境' })
  assert.doesNotMatch(renderedText(speech()), /组件与安装清单|本次不需要/)
  assert.equal(speech().findAllByProps({ 'data-runtime-details': 'cpu' }).length, 0)
  await act(async () => button('语音基础运行环境组件清单', speech()).props.onClick())
  const base = speech().findByProps({ 'aria-label': '语音基础运行环境组件' })
  assert.match(renderedText(base), /音频提取工具.*语音检测模型/)
  assert.doesNotMatch(renderedText(base), /CUDA|VULKAN/)
  await act(async () => button('语音GPU 加速支持组件清单', speech()).props.onClick())
  const gpu = speech().findByProps({ 'aria-label': '语音GPU 加速支持组件' })
  assert.match(renderedText(gpu), /CUDA/)
  assert.match(renderedText(gpu), /VULKAN/)
  assert.doesNotMatch(renderedText(gpu), /CPU|音频提取工具|语音检测模型|本次不需要/)
  assert.match(renderedText(speech().findByProps({ 'data-runtime-target': 'cpu' })), /90\.5 MB/)
  assert.match(renderedText(speech().findByProps({ 'data-runtime-target': 'gpu' })), /674\.5 MB/)
  assert.match(renderedText(base), /文件大小.*8\.6 MB.*81\.0 MB.*885\.1 KB/)
  assert.doesNotMatch(renderedText(speech()), /复用|无需下载|需下载|处理方式|新增下载/)
  await act(async () => changed({ ...state, checkingDependencies: true }))
  assert.equal(button('语音基础运行环境组件清单', speech()).props['aria-expanded'], true)
  assert.equal(button('语音GPU 加速支持组件清单', speech()).props['aria-expanded'], true)
  await act(async () => button('语音基础运行环境组件清单', speech()).props.onClick())
  assert.equal(speech().findAllByProps({ 'data-runtime-details': 'cpu' }).length, 0)
  assert.equal(speech().findAllByProps({ 'data-runtime-details': 'gpu' }).length, 1)
  assert.deepEqual(commands, [])
})

test('first installation, partial installation and CPU-only mode offer the corresponding environment actions', async () => {
  sharedEnvironment(() => false); await mount()
  const speech = () => renderer!.root.findByProps({ 'aria-label': '语音运行环境' })
  assert.match(renderedText(speech()), /基础运行环境.*未安装/)
  await act(async () => button('安装运行环境', speech()).props.onClick())
  assert.deepEqual(commands, [{ action: 'prepare-runtime', group: 'speech', target: 'cpu' }])
  const partial = structuredClone(state)
  partial.environments![0].components.find(item => item.id === 'whisper-cpu')!.installed = true
  await act(async () => changed(partial))
  assert.match(renderedText(speech()), /部分安装/)
  await act(async () => button('继续安装', speech()).props.onClick())
  const cpu = structuredClone(partial)
  cpu.environments![0].gpu.state = 'disabled'
  await act(async () => changed(cpu))
  assert.match(renderedText(speech()), /当前使用 CPU，GPU 暂不使用.*未安装/)
  assert.equal(speech().findAllByType('button').filter(node => String(node.props['aria-label']).includes('GPU 加速支持')).length, 0)
})

test('environment progress distinguishes completed CPU components from the active GPU install and remains cancellable', async () => {
  sharedEnvironment()
  const environment = state.environments!.find(item => item.group === 'text')!
  const plan = environment.gpuPreparation
  state.operation = 'download'; state.downloadKind = 'acceleration'; state.downloadLabel = '文本引擎 · CUDA'
  state.preparation = { plan, phase: 'downloading', itemId: 'translator-cuda', completedItems: 1 }
  await mount()
  const text = renderer!.root.findByProps({ 'aria-label': '文本运行环境' })
  assert.match(renderedText(text.findByProps({ 'data-runtime-target': 'cpu' })), /已安装/)
  assert.match(renderedText(text.findByProps({ 'data-runtime-target': 'gpu' })), /正在下载/)
  assert.equal(button('检查与修复', text).props.disabled, true)
  assert.ok(text.findByProps({ 'aria-label': '文本运行环境安装进度' }))
  await act(async () => button('暂停安装', text).props.onClick())
  assert.deepEqual(commands, [{ action: 'cancel-download' }])
})
test('dependency checking replaces old success after configuration and each precision waits for its new verification', async () => {
  sharedEnvironment()
  const variant = state.models[0].variants[0]
  variant.validation = { state: 'passed', execution: { backend: 'cuda', device: 'RTX 4080' } }
  await mount()
  assert.match(renderedText(row(variant.id)), /GPU 已验证/)
  const checking = structuredClone(state)
  checking.checkingDependencies = true
  checking.models[0].variants[0].validation = undefined
  checking.models[0].variants[0].dependencies = { state: 'checking', missing: [], backend: 'cpu', message: '正在检查依赖' }
  await act(async () => changed(checking))
  assert.match(renderedText(row(variant.id)), /正在检查依赖.*等待验证/)
  assert.doesNotMatch(renderedText(row(variant.id)), /GPU 已验证/)
  const waiting = structuredClone(checking)
  waiting.checkingDependencies = false
  waiting.models[0].variants[0].dependencies = { state: 'ready', missing: [], backend: 'cpu', message: '依赖检查通过 · CPU' }
  waiting.models[0].variants[0].validation = { state: 'waiting', message: '等待自动验证' }
  await act(async () => changed(waiting))
  assert.match(renderedText(row(variant.id)), /依赖检查通过.*等待验证/)
})

test('local models separate speech and text modalities, keep families compact, and do not expose usage selectors', async () => {
  await mount()
  const speech = renderer!.root.findAllByType('section').find(node => node.props['aria-label'] === '语音模型')!
  const text = renderer!.root.findAllByType('section').find(node => node.props['aria-label'] === '文本模型')!
  assert.equal(speech.findAllByType('article').length, 1)
  assert.equal(text.findAllByType('article').length, 2)
  assert.equal(renderer!.root.findAllByType('table').filter(node => String(node.props['aria-label']).endsWith('精度列表')).length, 2)
  const labels = renderer!.root.findAllByType(Select).map(node => node.props['aria-label'])
  assert.deepEqual(labels, ['语音模型筛选', 'Qwen 语音筛选', '文本模型筛选', '模型下载来源'])
})

test('precision browsing retains exact publisher identity and downloads never change usage', async () => {
  await mount(); await expand()
  assert.ok(row('qwen3-official-q8_0'))
  assert.ok(row('qwen3-q6_k'))
  assert.equal(commands.length, 0)
  await act(async () => button('下载模型', row('qwen3-q6_k')).props.onClick())
  assert.deepEqual(commands, [{ action: 'download', model: 'qwen3', variant: 'qwen3-q6_k' }])
  assert.equal(state.usage.subtitleTranslation.variant, 'qwen3-q4_k_m')
})

test('family headers contain inventory only and all state belongs to the single precision table', async () => {
  state.models[0].variants[0].validation = { state: 'passed', execution: { backend: 'cuda', device: 'RTX 4080' } }
  await mount()
  const header = renderer!.root.findByProps({ 'data-model-family-header': 'qwen3' })
  assert.doesNotMatch(renderedText(header), /GPU|已选用|字幕翻译|空闲/)
  assert.match(renderedText(header), /3 个精度 · 已下载 2/)
  assert.equal(renderer!.root.findAllByType('table').filter(node => node.props['aria-label'] === 'Qwen3 1.7B 精度列表').length, 1)
  assert.match(renderedText(row('qwen3-q4_k_m')), /GPU 已验证/)
  assert.match(renderedText(row('qwen3-official-q8_0')), /未验证/)
  assert.doesNotMatch(renderedText(row('qwen3-official-q8_0')), /GPU 已验证|等待验证/)
  assert.doesNotMatch(renderedText(renderer!.root), /管理精度/)
})

test('collapsing an active family hides its inline progress until reopened without a global summary', async () => {
  state.operation = 'download'; state.activeModel = 'qwen3'; state.activeVariant = 'qwen3-q6_k'
  await mount()
  await act(async () => button('Qwen3 1.7B 精度列表').props.onClick())
  assert.equal(renderer!.root.findAllByProps({ 'data-variant': 'qwen3-q6_k' }).length, 0)
  assert.equal(renderer!.root.findAllByType('progress').length, 0)
  assert.doesNotMatch(renderedText(renderer!.root), /当前无进行中的操作|下载 \/ 校验.*本地模型/)
  await act(async () => changed({ ...state, downloadBytes: 100 }))
  assert.equal(button('Qwen3 1.7B 精度列表').props['aria-expanded'], false)
  await expand()
  await act(async () => button('取消下载').props.onClick())
  assert.deepEqual(commands, [{ action: 'cancel-download' }])
})

test('GPU detection preparation exposes its probe before detection and missing selected devices do not masquerade as an absent GPU', async () => {
  sharedEnvironment()
  state.acceleration!.devices = []; state.acceleration!.detectionComplete = false
  const environment = state.environments![0]
  const inventory = state.environments!.flatMap(item => item.components)
  environment.gpu = { state: 'unchecked' }
  environment.preparation = runtimePlanFixture('speech', inventory)
  environment.gpuPreparation = runtimePlanFixture('speech', inventory, 'vulkan', true)
  await mount()
  const speech = () => renderer!.root.findByProps({ 'aria-label': '语音运行环境' })
  await act(async () => button('语音GPU 加速支持组件清单', speech()).props.onClick())
  assert.match(renderedText(speech()), /安装检测组件后继续识别显卡/)
  assert.match(renderedText(speech()), /文本引擎VULKAN/)
  const components = speech().findByProps({ 'aria-label': '语音GPU 加速支持组件' })
  const componentRows = components.findByType('tbody').findAllByType('tr')
  assert.deepEqual(componentRows.map(component => component.children.map(cell => renderedText(cell))), [
    ['语音引擎', 'VULKAN', '未安装', '18.1 MB', 'b5130', 'github.com'],
    ['文本引擎', 'VULKAN', '未安装', '33.3 MB', 'b11435', 'github.com']
  ])
  assert.doesNotMatch(renderedText(components), /应用内置/)
  const unavailable = structuredClone(state)
  unavailable.acceleration!.devices = [{ id: 'present', name: 'RTX 4080', backend: 'cuda', index: 0, memoryMiB: 16384 }]
  unavailable.acceleration!.policy = { mode: 'gpu', device: 'removed' }
  unavailable.environments![0].gpu.state = 'unavailable'
  await act(async () => changed(unavailable))
  assert.match(renderedText(speech()), /指定显卡不可用，请重新选择运行方式/)
  assert.doesNotMatch(renderedText(speech()), /无可用显卡|未检测到可用独显/)
})

test('precision details show the exact publisher and live validation without mixing another precision', async () => {
  state.models[0].variants[0].validation = { state: 'passed', execution: { backend: 'cpu', reason: 'GPU 运行库启动失败，已使用 CPU' } }
  await mount()
  await act(async () => menuItem('qwen3-q4_k_m', '精度与验证详情').props.onClick())
  const detail = renderer!.root.findByType(Modal)
  assert.match(renderedText(detail), /Qwen3 1.7B · Q4_K_M · bartowski/)
  assert.match(renderedText(detail), /GPU 运行库启动失败/)
  const newer = structuredClone(state)
  newer.models[0].variants[2].validation = { state: 'passed', execution: { backend: 'vulkan', device: 'other precision device' } }
  await act(async () => changed(newer))
  assert.doesNotMatch(renderedText(renderer!.root.findByType(Modal)), /other precision device/)
  await act(async () => detail.props.onCancel())
  assert.equal(renderer!.root.findAllByType(Modal).length, 0)
})

test('selected precisions share runtime support but retain independent verification and current task states', async () => {
  const variants = state.models[0].variants
  variants[0].references = ['字幕翻译']
  variants[0].validation = { state: 'passed', execution: { backend: 'cuda', device: 'RTX 4080' } }
  variants[2].references = ['文本翻译']
  variants[0].runtimeReady = variants[2].runtimeReady = true
  variants[2].validation = { state: 'passed', execution: { backend: 'cpu' } }
  await mount()
  const summaries = renderer!.root.findAll(node => !!node.props['data-model-variant'])
  const first = summaries.find(node => node.props['data-model-variant'] === variants[0].id)!
  const second = summaries.find(node => node.props['data-model-variant'] === variants[2].id)!
  assert.match(renderedText(first), /GPU 已验证/)
  assert.doesNotMatch(renderedText(first), /使用中|空闲|已选用/)
  assert.match(renderedText(first), /字幕翻译/)
  assert.match(renderedText(second), /CPU 已验证/)
  assert.doesNotMatch(renderedText(second), /GPU 已验证/)
  await act(async () => select('文本模型筛选').props.onChange({ target: { value: 'selected' } }))
  assert.equal(renderer!.root.findAll(node => !!node.props['data-model-variant']).filter(node => String(node.props['data-model-variant']).startsWith('qwen3')).length, 2)
})

test('precision usage badges follow the live execution and disappear when its lease ends', async () => {
  const model = state.models[0], variant = model.variants[0]
  variant.validation = { state: 'passed', execution: { backend: 'cuda', device: 'RTX 4080' } }
  variant.execution = { backend: 'cuda', device: 'previous task' }
  await mount()
  const identity = () => row(variant.id).findByProps({ scope: 'row' })
  assert.doesNotMatch(renderedText(identity()), /使用中|已选用/)
  model.inUse = variant.inUse = true; variant.execution = undefined
  await act(async () => changed(structuredClone(state)))
  assert.match(renderedText(identity()), /使用中/)
  assert.doesNotMatch(renderedText(identity()), /CPU 使用中|GPU 使用中/)
  assert.equal(menuItem(variant.id, '删除此精度').props.disabled, true)
  assert.equal(menuItem(variant.id, '导入模型文件').props.disabled, true)
  assert.equal(menuItem(variant.id, '校验与修复').props.disabled, true)
  assert.equal(button('更改并迁移').props.disabled, true)
  for (const backend of ['cuda', 'vulkan', 'metal', 'cpu', 'idle'] as const) {
    variant.execution = { backend, device: backend === 'cpu' || backend === 'idle' ? undefined : 'actual device' }
    await act(async () => changed(structuredClone(state)))
    const label = backend === 'cpu' ? 'CPU 使用中' : backend === 'idle' ? '使用中' : 'GPU 使用中'
    assert.equal(renderedText(identity().findByProps({ role: 'status' })), label)
    assert.doesNotMatch(renderedText(row('qwen3-official-q8_0').findByProps({ scope: 'row' })), /使用中/)
    assert.match(renderedText(row(variant.id)), /GPU 已验证/, 'configuration validation stays independent from current execution')
  }
  model.inUse = variant.inUse = false
  variant.execution = { backend: 'cpu' }
  await act(async () => changed(structuredClone(state)))
  assert.doesNotMatch(renderedText(identity()), /使用中/)
  assert.equal(menuItem(variant.id, '删除此精度').props.disabled, false)
  assert.equal(menuItem(variant.id, '导入模型文件').props.disabled, false)
  assert.equal(menuItem(variant.id, '校验与修复').props.disabled, false)
  assert.equal(button('更改并迁移').props.disabled, false)
  assert.deepEqual(commands, [])
})

test('a GPU fallback offers repair for its own precision without marking an idle model as running', async () => {
  state.acceleration = { supported: true, policy: { mode: 'auto' }, devices: [{ id: 'gpu', name: 'RTX 4080', backend: 'cuda', index: 0, memoryMiB: 16384 }],
    recognition: { backend: 'idle' }, translation: { backend: 'idle' }, error: null }
  const variant = state.models[0].variants[0]
  variant.references = ['字幕翻译']; variant.validation = { state: 'passed', execution: { backend: 'cpu', reason: '加速运行库未就绪' } }
  await mount()
  const summary = renderer!.root.findByProps({ 'data-model-variant': variant.id })
  assert.match(renderedText(summary), /CPU 可用 · 显卡未启用/)
  assert.doesNotMatch(renderedText(summary), /使用中|空闲/)
  await act(async () => button('修复并验证', summary).props.onClick())
  assert.deepEqual(commands, [{ action: 'prepare-acceleration', model: 'qwen3', variant: variant.id }])
  state.acceleration.devices = []
  await act(async () => changed(structuredClone(state)))
  assert.match(renderedText(renderer!.root), /CPU 已验证/)
  assert.doesNotMatch(renderedText(renderer!.root), /显卡未启用/)
  state.acceleration.policy = { mode: 'gpu', device: 'missing-device' }
  variant.validation.execution!.reason = '指定显卡不可用，已使用 CPU'
  await act(async () => changed(structuredClone(state)))
  assert.match(renderedText(renderer!.root), /CPU 可用 · 显卡未启用/)
  assert.match(renderedText(renderer!.root), /指定显卡不可用/)
})

test('a CPU-verified precision is ready when optional GPU support is not installed', async () => {
  sharedEnvironment()
  const variant = state.models[0].variants[0]
  variant.validation = { state: 'passed', execution: { backend: 'cpu', reason: '加速运行库未就绪' } }
  variant.dependencies = { state: 'cpu-fallback', missing: ['文本引擎 · CUDA'], backend: 'cuda', message: 'CPU 可用' }
  await mount()
  assert.match(renderedText(row(variant.id)), /CPU 就绪 · GPU 可选.*CPU 已验证/)
  assert.doesNotMatch(renderedText(row(variant.id)), /CPU 可用 · 显卡未启用/)
  assert.doesNotMatch(renderedText(row(variant.id)), /补齐并验证|安装 GPU 加速支持/)
  assert.deepEqual(commands, [])
})

test('installed filtering retains downloaded precisions and clearing it restores inline download cancellation', async () => {
  state.models[0].variants[0].references = ['字幕翻译']
  state.operation = 'download'; state.activeModel = 'hy-mt2-7b'; state.activeVariant = 'hy-mt2-7b-q8_0'
  await mount()
  await act(async () => select('文本模型筛选').props.onChange({ target: { value: 'installed' } }))
  const downloaded = renderer!.root.findAll(node => String(node.props['data-model-variant'] ?? '').startsWith('qwen3'))
  assert.deepEqual(downloaded.map(node => node.props['data-model-variant']), ['qwen3-q4_k_m', 'qwen3-official-q8_0'])
  await act(async () => select('文本模型筛选').props.onChange({ target: { value: 'selected' } }))
  assert.equal(renderer!.root.findAllByType('progress').length, 0)
  await act(async () => select('文本模型筛选').props.onChange({ target: { value: 'all' } }))
  const cancel = button('取消下载')
  assert.equal(cancel.props.disabled, false)
  await act(async () => cancel.props.onClick())
  assert.deepEqual(commands, [{ action: 'cancel-download' }])
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
  assert.doesNotMatch(renderedText(renderer!.root), /正在复制并校验模型文件/)
})

test('missing precisions offer acquisition actions and details without unavailable export or delete entries', async () => {
  await mount(); await expand()
  const missing = row('qwen3-q6_k')
  const menu = missing.findByType(FloatingLayer)
  const items = React.Children.toArray(menu.props.children.props.children) as React.ReactElement[]
  const labels = items.flatMap(item => React.Children.toArray(item.props.children).filter(child => typeof child === 'string'))
  assert.ok(labels.includes('精度与验证详情'))
  assert.ok(labels.includes('复制下载地址'))
  assert.ok(labels.includes('导入模型文件'))
  assert.ok(!labels.includes('导出模型文件'))
  assert.ok(!labels.includes('删除此精度'))
  assert.equal(button('下载模型', missing).props.disabled, false)
  await act(async () => menuItem('qwen3-q6_k', '精度与验证详情').props.onClick())
  assert.match(renderedText(renderer!.root.findByType(Modal)), /Qwen3 1.7B.*Q6_K.*bartowski/)
  assert.deepEqual(commands, [])
})

test('missing base environment prompts explicit CPU setup without downloading a model or requiring GPU support', async () => {
  sharedEnvironment(() => false)
  await mount(); await expand()
  await act(async () => button('下载模型', row('qwen3-q6_k')).props.onClick())
  assert.deepEqual(commands, [])
  const prompt = renderer!.root.findByType(Modal)
  assert.equal(prompt.props.title, '请先安装运行环境')
  assert.match(renderedText(prompt), /GPU 加速支持可选/)
  await act(async () => prompt.props.onConfirm())
  assert.deepEqual(commands, [{ action: 'prepare-runtime', group: 'text', target: 'cpu' }])
  assert.equal(renderer!.root.findAllByType(Modal).length, 0)
  const installed = structuredClone(state)
  installed.environments!.find(item => item.group === 'text')!.cpuReady = true
  await act(async () => changed(installed))
  await act(async () => button('下载模型', row('qwen3-q6_k')).props.onClick())
  assert.deepEqual(commands, [{ action: 'prepare-runtime', group: 'text', target: 'cpu' }, { action: 'download', model: 'qwen3', variant: 'qwen3-q6_k' }])
  const actionCell = row('qwen3-q6_k').findAllByType('td').at(-1)!
  assert.equal(actionCell.findAllByType('button').length, 2)
  assert.doesNotMatch(renderedText(actionCell), /GB|MB|需下载|预计/)
})

test('imports use their own model group prerequisite and do not resume automatically after CPU setup', async () => {
  sharedEnvironment(() => false)
  await mount(); await expand()
  const expected: LocalModelCommand[] = []
  for (const [model, variant, group] of [['kotoba', 'kotoba-q8_0', 'speech'], ['qwen3', 'qwen3-q6_k', 'text']] as const) {
    await act(async () => menuItem(variant, '导入模型文件').props.onClick())
    assert.deepEqual(commands, expected)
    const prompt = renderer!.root.findByType(Modal)
    assert.match(renderedText(prompt), new RegExp(`下载或导入模型前，请先安装${group === 'speech' ? '语音' : '文本'}模型的基础运行环境`))
    await act(async () => prompt.props.onConfirm())
    expected.push({ action: 'prepare-runtime', group, target: 'cpu' })
    assert.deepEqual(commands, expected)
    assert.equal(renderer!.root.findAllByType(Modal).length, 0)
    state = structuredClone(state)
    state.environments!.find(item => item.group === group)!.cpuReady = true
    await act(async () => changed(state))
    await act(async () => menuItem(variant, '导入模型文件').props.onClick())
    expected.push({ action: 'import', model, variant })
    assert.deepEqual(commands, expected)
    assert.equal(renderer!.root.findAllByType(Modal).length, 0)
  }
})

test('deletion allows referenced precisions with an explicit warning and confirms the exact precision', async () => {
  state.models[0].variants[0].references = ['字幕翻译']
  await mount(); await expand()
  assert.equal(menuItem('qwen3-q4_k_m', '删除此精度').props.disabled, false)
  await act(async () => menuItem('qwen3-q4_k_m', '删除此精度').props.onClick())
  assert.match(JSON.stringify(renderer!.toJSON()), /用途选择会保留/)
  await act(async () => renderer!.root.findByType(Modal).props.onCancel())
  await act(async () => menuItem('qwen3-official-q8_0', '删除此精度').props.onClick())
  assert.equal(commands.length, 0)
  assert.equal(renderer!.root.findByType(Modal).props.confirmDisabled, false)
  await act(async () => renderer!.root.findByType(Modal).props.onConfirm())
  assert.deepEqual(commands, [{ action: 'delete', model: 'qwen3', variant: 'qwen3-official-q8_0' }])
  assert.equal(renderer!.root.findAllByType(Modal).length, 0)
})

test('a running task arriving while deletion confirmation is open disables the confirmation', async () => {
  await mount(); await expand()
  await act(async () => menuItem('qwen3-official-q8_0', '删除此精度').props.onClick())
  const newer = structuredClone(state); newer.models[0].variants[2].inUse = true
  await act(async () => changed(newer))
  assert.equal(renderer!.root.findByType(Modal).props.confirmDisabled, true)
})

test('all models and precisions remain visible even when no files are installed', async () => {
  await mount(); await expand()
  const empty = structuredClone(state); empty.models.forEach(model => model.variants.forEach(variant => { variant.installed = false }))
  await act(async () => changed(empty))
  assert.equal(renderer!.root.findAllByType('article').length, empty.models.length)
  assert.equal(renderer!.root.findAllByProps({ 'data-variant': 'qwen3-q6_k' }).length, 1)
  assert.equal(renderer!.root.findAllByProps({ 'data-variant': 'qwen3-official-q8_0' }).length, 1)
  assert.deepEqual(renderer!.root.findAllByType(Select).map(node => node.props['aria-label']), ['语音模型筛选', 'Qwen 语音筛选', '文本模型筛选', '模型下载来源'])
})

test('targeted installation expands and highlights a missing nonrecommended precision, with a return route preserving scope', async () => {
  await mount('/settings/models/local?scope=library&model=hy-mt2-7b&variant=hy-mt2-7b-q8_0')
  assert.equal(row('hy-mt2-7b-q8_0').props['data-target'], true)
  assert.equal(renderer!.root.findAllByType('table').filter(node => String(node.props['aria-label']).endsWith('精度列表')).length, 3)
  await act(async () => button('返回用途配置').props.onClick())
  assert.equal(currentLocation, '/settings/models/usage?scope=library#ai-subtitles')
})

test('runtime readiness stays distinct from installed weights on unsupported and incomplete platforms', async () => {
  state.supported = false; state.models[0].variants[0].ready = false; state.models[0].variants[0].readiness = 'unsupported'
  await mount(); await expand()
  assert.equal(menuItem('qwen3-q4_k_m', '校验与修复').props.disabled, false)
  assert.ok(JSON.stringify(renderer!.toJSON()).includes('仅管理文件'))
  const incomplete = structuredClone(state); incomplete.supported = true; incomplete.models[0].variants[0].readiness = 'missing-runtime'
  await act(async () => changed(incomplete))
  assert.ok(JSON.stringify(renderer!.toJSON()).includes('待安装运行环境'))
  await act(async () => button('安装运行环境', row('qwen3-q4_k_m')).props.onClick())
  assert.deepEqual(commands, [{ action: 'prepare-runtime', group: 'text', target: 'cpu' }])
})

test('duplicate commands are excluded synchronously and newer events win over command responses', async () => {
  let finish!: (value: LocalModelSnapshot) => void
  command = () => new Promise(resolve => { finish = resolve })
  await mount(); await expand()
  const click = menuItem('qwen3-q4_k_m', '校验与修复').props.onClick
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
  await mount(); await expand()
  assert.equal(menuItem('qwen3-q6_k', '复制下载地址').props.disabled, false)
  assert.equal(menuItem('qwen3-q6_k', '导入模型文件').props.disabled, true)
  assert.equal(button('下载模型', row('qwen3-q6_k')).props.disabled, true)
  assert.equal(menuItem('qwen3-q4_k_m', '校验与修复').props['aria-busy'], true)
  assert.equal(button('取消下载').props.disabled, false)
  await act(async () => menuItem('qwen3-q6_k', '复制下载地址').props.onClick())
  assert.ok(JSON.stringify(renderer!.toJSON()).includes('下载地址已复制'))
  await act(async () => button('取消下载').props.onClick())
  assert.deepEqual(commands, [{ action: 'copy-download-url', model: 'qwen3', variant: 'qwen3-q6_k' }, { action: 'cancel-download' }])
})

test('an active text runtime blocks other text repairs while leaving speech repair and precision browsing available', async () => {
  state.models.find(model => model.id === 'hy-mt2-7b')!.inUse = true
  await mount(); await expand(); await expand('HY-MT2 7B'); await expand('Kotoba v2.0')
  assert.equal(menuItem('qwen3-q4_k_m', '校验与修复').props.disabled, true)
  assert.equal(menuItem('hy-mt2-7b-q4_k_m', '校验与修复').props.disabled, true)
  assert.equal(menuItem('kotoba-q4_k_m', '校验与修复').props.disabled, false)
  assert.ok(row('qwen3-q6_k'))
  assert.equal(button('更改并迁移').props.disabled, true)
})

test('HY exposes all catalog precisions, sizes and modalities without selecting uses', async () => {
  await mount(); await expand('HY-MT2 7B')
  await act(async () => button('下载模型', row('hy-mt2-7b-q8_0')).props.onClick())
  assert.deepEqual(commands, [ { action: 'download', model: 'hy-mt2-7b', variant: 'hy-mt2-7b-q8_0' } ])
  const rendered = JSON.stringify(renderer!.toJSON())
  const size = row('hy-mt2-7b-q4_k_m').findAllByType('span').find(node => node.children.join('') === '4.62 GB')
  assert.ok(size)
  assert.ok(rendered.includes('本地文本翻译'))
})

test('download source is saved immediately and locked while a download is running', async () => {
  await mount()
  await act(async () => select('模型下载来源').props.onChange({ target: { value: 'hf-mirror' } }))
  assert.deepEqual(commands, [{ action: 'download-source', source: 'hf-mirror' }])
  await act(async () => changed({ ...state, downloadSource: 'hf-mirror', operation: 'download' }))
  assert.equal(select('模型下载来源').props.value, 'hf-mirror')
  assert.equal(select('模型下载来源').props.disabled, true)
})

function storageSnapshot(): NonNullable<LocalModelSnapshot['storage']> {
  return { models: { bytes: 537819875, files: 4 }, runtimes: { bytes: 184600000, files: 33 },
    downloads: { bytes: 320000000, files: 2 }, staging: { bytes: 0, files: 0 }, cache: { bytes: 12800000, files: 16 },
    checkedAt: '2026-10-17T01:00:00Z' }
}
function storageRestore(): React.ReactElement {
  return renderer!.root.findAllByType(FloatingLayer).find(node => node.props.ariaLabel === '保存位置操作')!.props.children.props.children
}

test('storage table uses real counts and clears only the selected file group, then updates totals', async () => {
  state.storage = storageSnapshot()
  command = async () => {
    const group = commands.at(-1)!.action === 'clean-downloads' ? 'downloads' : 'cache'
    state = { ...state, storage: { ...state.storage!, [group]: { bytes: 0, files: 0 } } }
    return state
  }
  await mount()
  const table = renderer!.root.findAllByType('table').find(node => node.props['aria-label'] === '本地文件占用')!
  assert.match(renderedText(table), /文件分类文件大小文件数操作模型文件537.8 MB4 个文件/)
  assert.match(renderedText(renderer!.root), /合计占用1.06 GB/)
  assert.equal(button('清理未完成下载').props.disabled, false)
  await act(async () => button('清理未完成下载').props.onClick())
  assert.deepEqual(commands, [{ action: 'clean-downloads' }])
  assert.equal(button('清理未完成下载').props.disabled, true)
  assert.equal(button('清理推理缓存').props.disabled, false)
  assert.match(renderedText(table), /运行环境184.6 MB33 个文件.*未完成下载0 B0 个文件.*推理缓存12.8 MB16 个文件/)
  assert.match(renderedText(renderer!.root), /合计占用735.2 MB/)
  await act(async () => button('清理推理缓存').props.onClick())
  assert.equal(button('清理推理缓存').props.disabled, true)
  assert.match(renderedText(renderer!.root), /合计占用722.4 MB/)
  assert.deepEqual(commands, [{ action: 'clean-downloads' }, { action: 'clear-cache' }])
})

test('unknown storage remains unknown until refreshed, and read-only/native directory actions use existing commands', async () => {
  await mount()
  const table = renderer!.root.findAllByType('table').find(node => node.props['aria-label'] === '本地文件占用')!
  assert.match(renderedText(table), /模型文件——/)
  assert.doesNotMatch(renderedText(table), /0 B|0 个文件/)
  command = async () => ({ ...state, storage: storageSnapshot() })
  await act(async () => button('刷新统计').props.onClick())
  assert.match(renderedText(table), /模型文件537.8 MB4 个文件/)
  await act(async () => button('打开保存目录').props.onClick())
  await act(async () => button('更改并迁移').props.onClick())
  assert.deepEqual(commands, [{ action: 'refresh-storage' }, { action: 'open-location' }, { action: 'choose-location' }])
})

test('storage usage leases block cleanup and migration while keeping source and refresh available', async () => {
  state.storage = storageSnapshot(); state.models[0].inUse = true; state.directory = '/custom-models'
  await mount()
  assert.equal(button('清理未完成下载').props.disabled, true)
  assert.equal(button('清理推理缓存').props.disabled, true)
  assert.equal(button('更改并迁移').props.disabled, true)
  assert.equal(storageRestore().props.disabled, true)
  assert.equal(button('刷新统计').props.disabled, false)
  assert.equal(select('模型下载来源').props.disabled, false)
  const idle = structuredClone(state); idle.models[0].inUse = false
  await act(async () => changed(idle))
  assert.equal(button('清理未完成下载').props.disabled, false)
  assert.equal(storageRestore().props.disabled, false)
  await act(async () => changed({ ...idle, operation: 'download' }))
  assert.equal(button('清理推理缓存').props.disabled, true)
  assert.equal(button('刷新统计').props.disabled, true)
  assert.equal(storageRestore().props.disabled, true)
})

test('restore default is in the directory menu and uses reset-location only when allowed', async () => {
  await mount()
  assert.equal(storageRestore().props.disabled, true)
  await act(async () => changed({ ...state, directory: '/custom-models' }))
  assert.equal(storageRestore().props.disabled, false)
  await act(async () => storageRestore().props.onClick())
  assert.deepEqual(commands, [{ action: 'reset-location' }])
})

test('storage command failure stays local and preserves the last measured file counts', async () => {
  state.storage = storageSnapshot()
  command = async () => { throw new Error('缓存目录无法访问') }
  await mount()
  await act(async () => button('清理推理缓存').props.onClick())
  assert.match(renderedText(renderer!.root), /推理缓存12.8 MB16 个文件/)
  const alert = renderer!.root.findByProps({ role: 'alert' })
  assert.match(renderedText(alert), /操作失败，请查看错误详情/)
  await act(async () => button('错误详情', alert).props.onClick())
  assert.match(renderedText(renderer!.root.findByType(Modal)), /缓存目录无法访问/)
})

test('operation errors remain beside the precision and full detail is accessible without a global summary', async () => {
  const detail = '无法写入模型目录：' + '/very-long-path'.repeat(20)
  command = async () => { throw new Error(detail) }
  await mount(); await expand()
  assert.equal(renderer!.root.findAllByType('button').filter(node => renderedText(node) === '错误详情').length, 0)
  await act(async () => menuItem('qwen3-q4_k_m', '校验与修复').props.onClick())
  assert.notEqual(button('错误详情').props.disabled, true)
  assert.ok(row('qwen3-q4_k_m')); assert.ok(button('重试'))
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
      ? menuItem('qwen3-q4_k_m', '校验与修复').props.onClick()
      : menuItem('qwen3-q4_k_m', '导入模型文件').props.onClick())
    assert.notEqual(button('错误详情').props.disabled, true)
    command = async () => state // Copy does not clear the manager's historical error.
    await act(async () => menuItem('qwen3-q4_k_m', '复制下载地址').props.onClick())
    assert.ok(JSON.stringify(renderer!.toJSON()).includes('下载地址已复制'))
    assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).length, 0)
    assert.equal(renderer!.root.findAllByType('button').filter(node => renderedText(node) === '错误详情').length, 0)
    await act(async () => changed({ ...state }))
    assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).length, 0, 'repeated idle snapshots must not resurrect the same historical failure')
    await act(async () => changed({ ...state, operation: 'download', error: null }))
    assert.equal(renderer!.root.findAllByProps({ 'aria-label': '模型下载进度' }).length, 0)
    await act(async () => changed({ ...state, operation: null }))
    assert.notEqual(button('错误详情').props.disabled, true, 'a new failed operation with the same message must remain visible')
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
  assert.notEqual(button('错误详情').props.disabled, true)
  assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).length, 1)
  assert.ok(JSON.stringify(renderer!.toJSON()).includes('操作失败，请查看错误详情'))
})

test('Intel Mac environments distinguish CPU-only text from system Metal speech support', async () => {
  sharedEnvironment()
  for (const environment of state.environments!) {
    environment.gpu = { state: 'platform', backend: environment.group === 'speech' ? 'metal' : undefined }
    environment.components = environment.components.filter(item => item.backend === 'cpu' || item.backend === 'common')
  }
  await mount()
  const text = renderedText(renderer!.root)
  assert.ok(text.includes('当前文本运行库仅支持 CPU。'))
  assert.ok(text.includes('macOS 内置 Metal 加速支持，无需额外安装。实际启用状态见模型验证结果。'))
  assert.equal(renderer!.root.findAllByType('button').some(node => String(node.props['aria-label']).includes('安装 GPU 加速支持')), false)
})

test('Metal CPU fallback remains visible without a CUDA or Vulkan device inventory', async () => {
  sharedEnvironment()
  state.acceleration!.devices = []
  state.acceleration!.supported = false
  for (const environment of state.environments!) environment.gpu = { state: 'platform', backend: 'metal' }
  const variant = state.models[0].variants[0]
  variant.validation = { state: 'passed', execution: { backend: 'cpu', reason: 'GPU 显存分配失败，已自动回退 CPU' } }
  await mount()
  assert.match(renderedText(row(variant.id)), /CPU 可用 · 显卡未启用/)
  assert.match(renderedText(row(variant.id)), /显存不足，已验证 CPU/)
  assert.equal(renderer!.root.findAllByType('button').some(node => renderedText(node) === '修复并验证'), false)
})
