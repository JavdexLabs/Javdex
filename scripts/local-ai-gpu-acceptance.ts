// Real, isolated Windows inference acceptance. Never modifies the source model store.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import { createAiRuntimeInstaller } from '../apps/desktop/src/main/services/localModels/runtimeInstaller'
import { localModelAssets, DEFAULT_LOCAL_MODEL_VARIANTS } from '../apps/desktop/src/main/services/localModels/modelCatalog'
import { gpuRuntimeAssets } from '../apps/desktop/src/main/services/localModels/gpuManifest'
import { detectLocalGpuDevices, type LocalRuntimeAcceleration } from '../apps/desktop/src/main/services/localModels/runtimeAcceleration'
import { createLocalTextInference } from '../apps/desktop/src/main/services/localModels/textInference'
import { createOfflineSubtitleInference } from '../apps/desktop/src/main/player/aiSubtitles/offlineInference'
import { runLocalModelProcess } from '../apps/desktop/src/main/services/localModels/processRunner'
import type { LocalExecutionStatus } from '../packages/contracts/src/desktop/localModels'

async function main(): Promise<void> {
  assert.equal(process.platform, 'win32', 'Run the Windows GPU acceptance on Windows')
  const argument = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index < 0 ? undefined : path.resolve(process.argv[index + 1]) }
  const source = argument('--source-root'), audio = argument('--audio')
  assert.ok(source && audio, 'Provide --source-root <existing local-ai store> and --audio <public Japanese sample>')
  const output = path.resolve('out/ai-runtime-acceptance/gpu'), root = path.join(output, 'runtime')
  const relative = path.relative(source, root)
  assert.ok(relative && (relative.startsWith('..') || path.isAbsolute(relative)), 'Acceptance store must be outside the source store')
  await fs.mkdir(output, { recursive: true })
  for (const group of ['models', 'runtimes']) {
    if (!await fs.stat(path.join(root, group)).then(() => true, () => false)) {
      await fs.cp(path.join(source, group), path.join(root, group), { recursive: true, dereference: false, errorOnExist: true, force: false })
    }
  }
  const cache = argument('--download-cache')
  const target = { platform: process.platform, arch: process.arch }
  const allGpu = [...gpuRuntimeAssets(target, 'cuda'), ...gpuRuntimeAssets(target, 'vulkan')]
  const download: typeof fetch = async (input, init) => {
    const asset = allGpu.find(asset => asset.url === String(input))
    const cached = asset && cache ? path.join(cache, asset.filename) : undefined
    if (cached && await fs.stat(cached).then(stat => stat.size === asset!.bytes, () => false) && !new Headers(init?.headers).has('range')) {
      return new Response(Readable.toWeb(createReadStream(cached)) as ReadableStream<Uint8Array>)
    }
    if (process.argv.includes('--offline')) throw new Error('Offline acceptance forbids external downloads')
    return fetch(input, init)
  }
  const cpu = createAiRuntimeInstaller(root)
  assert.equal(await cpu.installed(), true, 'Source store must have the default CPU tools and models')
  for (const backend of ['cuda', 'vulkan'] as const) {
    const assets = gpuRuntimeAssets(target, backend)
    const installer = createAiRuntimeInstaller(root, download, [...assets, ...localModelAssets(DEFAULT_LOCAL_MODEL_VARIANTS).filter(asset => !asset.archive)])
    console.log('Install/verify', backend)
    let last = 0
    await installer.install(new AbortController().signal, (bytes, label) => { if (Date.now() - last > 10000) { console.log(label, bytes); last = Date.now() } }, assets.map(asset => asset.id))
  }
  const gpuPaths = (backend: 'cuda' | 'vulkan') => createAiRuntimeInstaller(root, download,
    [...gpuRuntimeAssets(target, backend), ...localModelAssets(DEFAULT_LOCAL_MODEL_VARIANTS).filter(asset => !asset.archive)]).paths()
  const cuda = gpuPaths('cuda'), vulkan = gpuPaths('vulkan')
  const devices = await detectLocalGpuDevices({ translator: vulkan.translator })
  assert.ok(devices.some(device => /RTX 4080/.test(device.name)), 'A real RTX 4080 must be enumerated')
  const states: Record<string, LocalExecutionStatus> = {}
  const acceleration: LocalRuntimeAcceleration = { policy: { mode: 'auto' }, devices,
    runtimes: { cuda: { translator: cuda.translator, whisper: cuda.whisper, libraryDirectory: path.dirname(cuda.translator) + '-dependencies' }, vulkan: { translator: vulkan.translator, whisper: vulkan.whisper } },
    status: (engine, status) => { states[engine] = status; console.log(engine, JSON.stringify(status)) } }
  const report: { status: string; devices: typeof devices; checks: unknown[]; failure?: string } = { status: 'running', devices, checks: [] }
  const signal = new AbortController().signal
  const request: typeof fetch = async (input, init) => { assert.equal(new URL(String(input)).hostname, '127.0.0.1'); return fetch(input, init) }
  const text = '今日は天気がいいです。図書館に行きます。'
  async function translate(name: string, settings: LocalRuntimeAcceleration, expected: string, model: 'qwen3' | 'hy-mt2-7b' = 'qwen3'): Promise<void> {
    const paths = createAiRuntimeInstaller(root, undefined, localModelAssets(DEFAULT_LOCAL_MODEL_VARIANTS, model)).paths()
    let diagnosticIndex = 0
    const engine = createLocalTextInference({ ...paths, acceleration: settings }, { request,
      nativeDiagnostic: text => { void fs.writeFile(path.join(output, `${name}-${diagnosticIndex++}.log`), text) } })
    const start = performance.now()
    try {
      const result = await engine.translateText(text, signal)
      assert.match(result, /天气|图书馆/)
      assert.equal(states.translation.backend, expected)
      const gpuMemory = await runLocalModelProcess('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'])
      report.checks.push({ name, model, milliseconds: Math.round(performance.now() - start), result, execution: { ...states.translation }, gpuMemoryMiB: gpuMemory.trim() })
    } finally { await engine.close() }
  }
  try {
    await translate('cuda-qwen', acceleration, 'cuda')
    await translate('cuda-hy', acceleration, 'cuda', 'hy-mt2-7b')
    if (devices.some(device => device.backend === 'vulkan')) {
      await translate('vulkan-qwen', { ...acceleration, policy: { mode: 'gpu', device: devices.find(device => device.backend === 'vulkan')!.id } }, 'vulkan')
    }
    const subtitle = createOfflineSubtitleInference({ ...cpu.paths(), acceleration }, path.join(output, 'work'), { request,
      nativeDiagnostic: text => { void fs.appendFile(path.join(output, 'recognition-native.log'), text) } })
    try {
      const start = performance.now(), cues = await subtitle.recognize(audio, 0, 0, 20, signal)
      assert.ok(cues.length > 0 && cues.some(cue => /海外|大学|入学|場合/.test(cue.japanese)))
      assert.equal(states.recognition.backend, 'cuda')
      const bilingual = await subtitle.translate(cues, signal, async () => {})
      assert.ok(bilingual.every(cue => !!cue.chinese))
      report.checks.push({ name: 'cuda-recognition-bilingual', milliseconds: Math.round(performance.now() - start), bilingual, execution: structuredClone(states) })
    } finally { await subtitle.close() }
    for (const [name, settings, expected] of [
      ['vulkan-recognition', { ...acceleration, policy: { mode: 'gpu', device: devices.find(device => device.backend === 'vulkan')?.id } }, 'vulkan'],
      ['cpu-recognition', { ...acceleration, policy: { mode: 'cpu' } }, 'cpu'],
      ['broken-gpu-recognition', { ...acceleration, runtimes: { cuda: { whisper: path.join(output, 'absent-whisper.exe') } } }, 'cpu']
    ] as const) {
      const instance = createOfflineSubtitleInference({ ...cpu.paths(), acceleration: settings }, path.join(output, 'work'), { request })
      const start = performance.now()
      try {
        const cues = await instance.recognize(audio, 0, 0, 20, signal)
        assert.ok(cues.some(cue => /海外|大学|場合/.test(cue.japanese)))
        assert.equal(states.recognition.backend, expected)
        report.checks.push({ name, milliseconds: Math.round(performance.now() - start), execution: { ...states.recognition }, cues })
      } finally { await instance.close() }
    }
    await translate('forced-cpu', { ...acceleration, policy: { mode: 'cpu' } }, 'cpu')
    await translate('no-discrete-gpu', { ...acceleration, devices: [] }, 'cpu')
    await translate('missing-gpu-runtime', { ...acceleration, runtimes: {} }, 'cpu')
    await translate('broken-gpu-executable', { ...acceleration, runtimes: { cuda: { translator: path.join(output, 'absent', 'llama-server.exe') } } }, 'cpu')
    await translate('native-no-usable-gpu', { ...acceleration, devices: [{ ...devices[0], id: 'GPU-00000000-0000-0000-0000-000000000000' }] }, 'cpu')
    report.status = 'pass'
  } catch (cause) { report.status = 'failed'; report.failure = String(cause); throw cause }
  finally { await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)) }
}
void main().catch(cause => { console.error(cause); process.exitCode = 1 })
