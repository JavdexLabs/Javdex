import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createAiRuntimeInstaller } from './runtimeInstaller'
import { createLocalModelManager } from './localModelManager'
import { localModelVariant } from './modelCatalog'
import { modelAssetDirectory, modelDownloadFile } from './modelStorage'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-preparation-'))
  const installed = new Set<string>(), downloads: string[] = []
  let failure: string | undefined
  const installer: typeof createAiRuntimeInstaller = (directory, download, assets, options) => {
    const runtime = createAiRuntimeInstaller(directory, download, assets, options)
    const key = (id: string) => {
      const asset = assets!.find(asset => asset.id === id)!
      return asset.model ? asset.filename : `${id}-${asset.backend ?? 'cpu'}`
    }
    return { ...runtime, assetsInstalled: async ids => ids.every(id => installed.has(key(id))),
      removeAsset: async id => { installed.delete(key(id)); await runtime.removeAsset(id) },
      install: async (signal, _progress, ids = [], event) => {
        for (const id of ids) {
          signal.throwIfAborted()
          const name = key(id), reused = installed.has(name)
          event?.({ phase: 'checking', networkBytes: 0, networkTotal: 0 })
          await delay(3, undefined, { signal })
          if (name === failure) throw new Error('fixture connection failed')
          if (!reused) { downloads.push(name); installed.add(name) }
          event?.({ phase: reused ? 'reused' : 'downloading', networkBytes: reused ? 0 : 10, networkTotal: reused ? 0 : 10 })
          event?.({ phase: reused ? 'reused' : 'complete', networkBytes: reused ? 0 : 10, networkTotal: reused ? 0 : 10 })
        }
      }
    }
  }
  const manager = createLocalModelManager(root, { installer, runtimeSupported: () => true,
    detectDevices: async () => [{ id: 'gpu', name: 'RTX 4080', backend: 'cuda', index: 0, memoryMiB: 16384 }],
    validate: async paths => ({ backend: paths.acceleration?.policy.mode !== 'cpu' && paths.acceleration?.runtimes?.cuda?.translator ? 'cuda' : 'cpu' }) })
  async function idle() {
    for (let i = 0; i < 100; i++) { if (!(await manager.snapshot()).operation) return; await delay(10) }
    assert.fail('preparation did not finish')
  }
  return { root, manager, downloads, installed, idle, fail: (name: string) => { failure = name }, cleanup: async () => { await manager.close(); await fs.rm(root, { recursive: true, force: true }) } }
}
const windows = { skip: process.platform !== 'win32' || process.arch !== 'x64' }
test('base deletion checks only its own modality while GPU deletion retains a usable CPU environment', windows, async () => {
  const f = await fixture()
  try {
    await f.manager.prepareRuntime('speech', 'cpu'); await f.idle()
    await f.manager.prepareRuntime('text', 'gpu'); await f.idle()
    await f.manager.download('hy-mt2-7b'); await f.idle()
    const before = await f.manager.snapshot()
    await assert.rejects(f.manager.removeRuntime('text', 'cpu'), /先删除所有文本模型文件/)
    assert.equal((await f.manager.snapshot()).operation, null)
    await f.manager.removeRuntime('speech', 'cpu')
    const independent = await f.manager.snapshot()
    assert.equal(independent.environments!.find(item => item.group === 'speech')!.cpuReady, false)
    assert.equal(independent.environments!.find(item => item.group === 'text')!.cpuReady, true)
    assert.ok(independent.models.find(item => item.id === 'hy-mt2-7b')!.installed)
    await assert.rejects(f.manager.subtitleRuntime().removeAsset('ffmpeg'), /不支持删除单个组件/)
    const release = await f.manager.acquire(['hy-mt2-7b'])
    try { await assert.rejects(f.manager.removeRuntime('text', 'gpu'), /正在使用/) }
    finally { release() }
    await f.manager.removeRuntime('text', 'gpu')
    let after = await f.manager.snapshot()
    assert.equal(after.environments!.find(item => item.group === 'text')!.cpuReady, true)
    assert.equal(after.environments!.find(item => item.group === 'text')!.gpu.state, 'missing')
    const model = after.models.find(item => item.id === 'hy-mt2-7b')!
    assert.equal(model.variants.find(item => item.id === model.selectedVariant)!.ready, true)
    assert.deepEqual(after.usage, before.usage)
    let checked = model.variants.find(item => item.id === model.selectedVariant)!
    for (let i = 0; i < 100 && checked.validation?.state !== 'passed'; i++) {
      await delay(10)
      checked = (await f.manager.snapshot()).models.find(item => item.id === 'hy-mt2-7b')!.variants.find(item => item.id === model.selectedVariant)!
    }
    assert.equal(checked.validation?.state, 'passed')
    assert.equal(checked.validation?.execution?.backend, 'cpu')
    await f.manager.remove('hy-mt2-7b')
    await f.manager.removeRuntime('text', 'cpu')
    after = await f.manager.snapshot()
    assert.ok(after.environments!.every(item => !item.cpuReady))
    assert.equal(f.installed.size, 0)
    assert.deepEqual(after.usage, before.usage)
  } finally { await f.cleanup() }
})
for (const model of ['kotoba', 'qwen3', 'hy-mt2-7b'] as const) test(`${model} partial and damaged files block only their corresponding environment`, windows, async () => {
  const f = await fixture()
  try {
    await f.manager.prepareRuntime('speech', 'cpu'); await f.idle()
    await f.manager.prepareRuntime('text', 'cpu'); await f.idle()
    const group = model === 'kotoba' ? 'speech' : 'text'
    const other = group === 'speech' ? 'text' : 'speech'
    const variant = localModelVariant(model)
    const asset = variant.asset
    const directory = (await f.manager.snapshot()).directory
    const partial = modelDownloadFile(directory, asset)
    await fs.mkdir(path.dirname(partial), { recursive: true }); await fs.writeFile(partial, 'partial')
    await f.manager.detectDevices()
    const precision = (await f.manager.snapshot()).models.find(item => item.id === model)!.variants.find(item => item.id === variant.id)!
    assert.equal(precision.installed, false)
    assert.equal(precision.hasFiles, true)
    await assert.rejects(f.manager.removeRuntime(group, 'cpu'), /未完成的模型下载/)
    await f.manager.removeRuntime(other, 'cpu')
    assert.equal(await fs.readFile(partial, 'utf8'), 'partial')
    await f.manager.remove(model, variant.id)
    await assert.rejects(fs.stat(partial), { code: 'ENOENT' })
    const damaged = path.join(modelAssetDirectory(directory, asset), asset.filename)
    await fs.mkdir(path.dirname(damaged), { recursive: true }); await fs.writeFile(damaged, 'damaged')
    await assert.rejects(f.manager.removeRuntime(group, 'cpu'), /先删除所有/)
    await f.manager.remove(model, variant.id)
    await f.manager.removeRuntime(group, 'cpu')
    assert.equal(f.installed.size, 0)
  } finally { await f.cleanup() }
})
test('runtime removal rejects invalid identities and detects files from retired model revisions', windows, async () => {
  const f = await fixture()
  try {
    await f.manager.prepareRuntime('text', 'cpu'); await f.idle()
    // Runtime checks also reject non-IPC callers with injected or per-component targets.
    await assert.rejects(f.manager.removeRuntime('../outside' as 'text', 'cpu'), /未知运行环境/)
    await assert.rejects(f.manager.removeRuntime('text', 'translator-cpu' as 'cpu'), /未知运行环境/)
    const directory = (await f.manager.snapshot()).directory
    const old = path.join(directory, 'models', 'hy-mt2-7b', 'tencent', 'retired-revision', 'weights.gguf')
    const speech = path.join(directory, 'models', 'kotoba-whisper-v2.0', 'kotoba-tech', 'retired-revision', 'weights.bin')
    await fs.mkdir(path.dirname(speech), { recursive: true }); await fs.writeFile(speech, 'old speech model')
    await fs.mkdir(path.dirname(old), { recursive: true }); await fs.writeFile(old, 'old model')
    await assert.rejects(f.manager.removeRuntime('text', 'cpu'), /先删除所有/)
    assert.ok(f.installed.has('translator-cpu'))
    await fs.rm(old)
    await f.manager.removeRuntime('text', 'cpu')
    assert.equal(f.installed.size, 0)
    assert.equal(await fs.readFile(speech, 'utf8'), 'old speech model')
  } finally { await f.cleanup() }
})
test('basic environment installation excludes GPU downloads and later GPU installation reuses it without changing policy or model bindings', windows, async () => {
  const f = await fixture()
  try {
    const before = await f.manager.snapshot()
    await f.manager.prepareRuntime('text', 'cpu'); await f.idle()
    let state = await f.manager.snapshot()
    assert.deepEqual(f.downloads, ['translator-cpu'])
    assert.equal(state.environments!.find(item => item.group === 'text')!.cpuReady, true)
    assert.equal(state.environments!.find(item => item.group === 'text')!.gpu.state, 'missing')
    assert.deepEqual(state.acceleration!.policy, before.acceleration!.policy)
    assert.deepEqual(state.usage, before.usage)
    await f.manager.prepareRuntime('text', 'gpu'); await f.idle()
    state = await f.manager.snapshot()
    assert.deepEqual(f.downloads, ['translator-cpu', 'translator-cuda', 'cuda-cuda'])
    assert.equal(state.environments!.find(item => item.group === 'text')!.gpu.state, 'ready')
    assert.ok(state.models.every(model => model.variants.every(variant => !variant.installed)))
  } finally { await f.cleanup() }
})

test('model downloads require the base environment and never install GPU components, including across text families', windows, async () => {
  const f = await fixture()
  try {
    const before = await f.manager.snapshot()
    const initial = before.models.find(model => model.id === 'hy-mt2-7b')!.variants[0]
    assert.deepEqual(initial.preparation!.items.map(item => item.id), [`model:${initial.id}`])
    await assert.rejects(f.manager.download('hy-mt2-7b'), /请先安装文本模型的基础运行环境/)
    await assert.rejects(f.manager.subtitleRuntime().install(new AbortController().signal, () => {}), /请先安装.*基础运行环境/)
    assert.deepEqual(f.downloads, [])
    assert.equal((await f.manager.snapshot()).operation, null)
    await f.manager.prepareRuntime('text', 'cpu'); await f.idle()
    const waitingForModel = (await f.manager.snapshot()).models.find(model => model.id === 'hy-mt2-7b')!.variants[0]
    assert.equal(waitingForModel.installed, false)
    assert.equal(waitingForModel.dependencies!.state, 'cpu-fallback')
    assert.ok(waitingForModel.dependencies!.missing.every(name => !name.includes('HY-MT2')))
    const importSource = path.join(f.root, 'import.gguf')
    await fs.writeFile(importSource, 'not a model')
    await assert.rejects(f.manager.importModel('hy-mt2-7b', importSource), /文件大小与所选模型精度不匹配/)
    assert.deepEqual(f.downloads, ['translator-cpu'])
    await f.manager.download('hy-mt2-7b'); await f.idle()
    assert.deepEqual(f.downloads, ['translator-cpu', 'Hy-MT2-7B-Q4_K_M.gguf'])
    let state = await f.manager.snapshot()
    assert.equal(state.downloadBytes, 10)
    assert.equal(state.downloadTotal, 10)
    assert.equal(state.environments!.find(item => item.group === 'text')!.gpu.state, 'missing')
    assert.equal(state.models.find(model => model.id === 'hy-mt2-7b')!.variants[0].ready, true)
    assert.equal(state.environments!.find(item => item.group === 'speech')!.cpuReady, false)
    await assert.rejects(f.manager.download('kotoba'), /请先安装语音模型-Whisper的基础运行环境/)
    await f.manager.download('qwen3'); await f.idle()
    assert.equal(f.downloads.length, 3)
    state = await f.manager.snapshot()
    assert.equal(state.downloadBytes, 10)
    assert.equal(state.downloadTotal, 10)
    assert.equal(state.models.find(model => model.id === 'qwen3')!.variants[0].dependencies!.state, 'cpu-fallback')
    assert.deepEqual(state.usage, before.usage)
  } finally { await f.cleanup() }
})
test('shared environment preparation never downloads weights and GPU failure retains a usable CPU environment', windows, async () => {
  const f = await fixture()
  try {
    f.fail('translator-cuda')
    await f.manager.prepareRuntime('text', 'gpu'); await f.idle()
    const state = await f.manager.snapshot(), environment = state.environments!.find(item => item.group === 'text')!
    assert.equal(environment.cpuReady, true)
    assert.equal(environment.gpu.state, 'missing')
    assert.ok(state.models.every(model => model.variants.every(variant => !variant.installed)))
    assert.match(state.error!, /文本引擎.*fixture connection failed/)
    assert.deepEqual(state.operationError, { message: state.error, command: { action: 'prepare-runtime', group: 'text', target: 'gpu' } })
    assert.equal(state.activeVariant, null, 'the failure target survives cleared active flags')
    assert.deepEqual(f.downloads, ['translator-cpu'])
    f.fail('')
    await f.manager.prepareAcceleration('hy-mt2-7b', 'hy-mt2-7b-q4_k_m'); await f.idle()
    assert.deepEqual(f.downloads, ['translator-cpu', 'translator-cuda', 'cuda-cuda'])
    assert.equal((await f.manager.snapshot()).operationError, undefined)
    assert.ok((await f.manager.snapshot()).models.every(model => model.variants.every(variant => !variant.installed)))
  } finally { await f.cleanup() }
})
test('a configuration save rechecks dependencies immediately and discards the previous precision result', windows, async () => {
  const f = await fixture()
  try {
    await f.manager.prepareRuntime('text', 'gpu'); await f.idle()
    await f.manager.download('hy-mt2-7b'); await f.idle()
    for (let i = 0; i < 100; i++) {
      if ((await f.manager.snapshot()).models.find(model => model.id === 'hy-mt2-7b')!.variants[0].validation?.state === 'passed') break
      await delay(10)
    }
    f.installed.delete('translator-cuda')
    const checks: boolean[] = [], unsubscribe = f.manager.onChanged(() => { void f.manager.snapshot().then(state => checks.push(state.checkingDependencies === true)) })
    await f.manager.setAcceleration({ mode: 'gpu', device: 'gpu' })
    unsubscribe()
    let state = await f.manager.snapshot(), variant = state.models.find(model => model.id === 'hy-mt2-7b')!.variants[0]
    assert.ok(checks.includes(true))
    assert.equal(variant.dependencies!.state, 'cpu-fallback')
    assert.match(variant.dependencies!.message, /文本引擎 · CUDA/)
    assert.equal(variant.validation!.state, 'waiting')
    await f.manager.setAcceleration({ mode: 'cpu' })
    state = await f.manager.snapshot(); variant = state.models.find(model => model.id === 'hy-mt2-7b')!.variants[0]
    assert.equal(variant.dependencies!.state, 'ready')
    assert.equal(variant.preparation!.backend, 'cpu')
    assert.equal(variant.preparation!.downloadBytes, 0)
    assert.equal(variant.validation!.state, 'waiting')
  } finally { await f.cleanup() }
})
