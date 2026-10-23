import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LocalRuntimeComponent } from '@shared/desktop/localModels'
import { preparationPlan, runtimeBackend, runtimeComponentDefinitions } from './runtimeComponents'

const target = { platform: 'win32', arch: 'x64' }
const devices = [{ id: 'gpu', name: 'RTX 4080', backend: 'cuda' as const, index: 0, memoryMiB: 16384 }]
function components(installed: (id: string) => boolean = () => false): LocalRuntimeComponent[] {
  return runtimeComponentDefinitions(target).map(({ component }) => ({ ...component, installed: installed(component.id) }))
}
test('text families and precisions share one CPU engine while keeping distinct weights', () => {
  const plan = preparationPlan({ groups: ['text'], refs: [{ model: 'qwen3', variant: 'qwen3-q4_k_m' }, { model: 'hy-mt2-7b', variant: 'hy-mt2-7b-q6_k' }, { model: 'qwen3', variant: 'qwen3-q4_k_m' }],
    components: components(), policy: { mode: 'cpu' }, devices, target, supported: true, installed: () => false })
  assert.equal(plan.items.filter(item => item.id === 'translator-cpu').length, 1)
  assert.equal(plan.items.filter(item => item.id.startsWith('model:')).length, 2)
  assert.equal(plan.items.length, 3)
})
test('preparing a text precision includes missing CUDA components and reuses CPU without downloading speech', () => {
  const plan = preparationPlan({ groups: ['text'], refs: [{ model: 'qwen3', variant: 'qwen3-q4_k_m' }],
    components: components(id => id === 'translator-cpu'), policy: { mode: 'auto' }, devices, target, supported: true, installed: () => true })
  assert.equal(plan.backend, 'cuda')
  assert.deepEqual(plan.items.filter(item => item.action === 'download').map(item => item.id), ['translator-cuda', 'cuda-cuda'])
  assert.equal(plan.downloadBytes, 264473456 + 391443627)
  assert.ok(plan.items.every(item => item.group === 'text'))
})
test('speech preparation includes auxiliary resources and only its own packaged CUDA engine', () => {
  const plan = preparationPlan({ groups: ['speech'], components: components(), policy: { mode: 'auto' }, devices, target, supported: true, installed: () => false })
  assert.deepEqual(plan.items.map(item => item.id), ['whisper-cpu', 'ffmpeg-common', 'vad-common', 'whisper-cuda'])
})

test('Qwen preparation includes its pinned aligner and native engine without downloading Kotoba tools', () => {
  const plan = preparationPlan({ groups: ['speech2'], refs: [{ model: 'qwen3-asr', variant: 'qwen3-asr-q8_0' }],
    components: components(), policy: { mode: 'auto' }, devices, target, supported: true, installed: () => false })
  assert.equal(plan.backend, 'vulkan')
  assert.ok(plan.items.some(item => item.id === 'qwen-aligner-common' && item.bytes === 1129966496))
  assert.ok(plan.items.some(item => item.id === 'audiocpp-cpu'))
  assert.ok(plan.items.some(item => item.id === 'audiocpp-vulkan'))
  assert.ok(plan.items.every(item => !/whisper|kotoba|vad/.test(item.id)))
  assert.ok(plan.items.some(item => item.id === 'translator-vulkan'), 'shared native device probe supplies discrete GPU memory information')
})

test('the two speech modules expose independent environments and reuse one physical audio-tool download', () => {
  const options = { components: components(), policy: { mode: 'cpu' as const }, devices: [], target, supported: true, installed: () => false }
  const kotoba = preparationPlan({ ...options, groups: ['speech'] })
  const qwen = preparationPlan({ ...options, groups: ['speech2'] })
  assert.ok(kotoba.items.every(item => item.group === 'speech'))
  assert.ok(qwen.items.every(item => item.group === 'speech2'))
  assert.ok(qwen.items.some(item => item.id === 'audiocpp-cpu'))
  assert.ok(kotoba.items.some(item => item.id === 'whisper-cpu'))
  const both = preparationPlan({ ...options, groups: ['speech', 'speech2'] })
  assert.equal(both.items.filter(item => item.id.startsWith('ffmpeg-')).length, 1)
})
test('automatic CPU fallback avoids speculative GPU downloads; explicit Vulkan preparation declares its probe', () => {
  const options = { groups: ['speech' as const], components: components(), policy: { mode: 'auto' as const }, devices: [], target, supported: true, installed: () => false }
  assert.ok(preparationPlan(options).items.every(item => !/cuda|vulkan/.test(item.id)))
  const explicit = preparationPlan({ ...options, forceGpu: true })
  assert.equal(explicit.items.find(item => item.id === 'whisper-vulkan')?.action, 'download')
  assert.equal(explicit.items.find(item => item.id === 'whisper-vulkan')?.downloadBytes, 18095994)
  assert.ok(explicit.items.some(item => item.id === 'translator-vulkan' && item.group === 'text'))
})
test('network planning excludes reusable and resumable bytes and never installs tools on unsupported hosts', () => {
  const plan = preparationPlan({ groups: ['text'], refs: [{ model: 'qwen3', variant: 'qwen3-q4_k_m' }],
    components: components(), policy: { mode: 'auto' }, devices, target, supported: false, installed: () => false, resumed: () => 100 })
  assert.equal(plan.items.length, 1)
  assert.equal(plan.downloadBytes, 1282439584 - 100)
  const complete = preparationPlan({ groups: ['text'], refs: [{ model: 'qwen3', variant: 'qwen3-q4_k_m' }], components: components(),
    policy: { mode: 'cpu' }, devices: [], target, supported: false, installed: () => false, resumed: () => 1282439584 })
  assert.equal(complete.items[0].action, 'verify')
  assert.equal(complete.downloadBytes, 0)
})
test('automatic plans choose the same installed alternative backend as execution', () => {
  const inventory = components(id => id === 'translator-vulkan')
  const adapters = [...devices, { ...devices[0], id: 'vulkan:0', backend: 'vulkan' as const }]
  assert.equal(runtimeBackend('text', { mode: 'auto' }, adapters, inventory), 'vulkan')
  assert.equal(runtimeBackend('text', { mode: 'gpu', device: 'gpu' }, adapters, inventory), 'cuda')
})
test('macOS bundled speech tools are installation resources rather than network downloads', () => {
  const inventory = runtimeComponentDefinitions({ platform: 'darwin', arch: 'arm64' }).map(({ component }) => ({ ...component, installed: false }))
  const plan = preparationPlan({ groups: ['speech'], components: inventory, policy: { mode: 'auto' }, devices: [],
    target: { platform: 'darwin', arch: 'arm64' }, supported: true, installed: () => false })
  assert.equal(plan.backend, 'metal')
  assert.equal(plan.items.filter(item => item.action === 'install').length, 2)
  assert.equal(plan.downloadBytes, 885098)
})
