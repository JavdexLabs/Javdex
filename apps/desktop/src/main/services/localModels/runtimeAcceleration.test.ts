import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess, spawn } from 'node:child_process'
import { createLocalTextInference } from './textInference'
import { gpuDiagnosticFailure, gpuLoaderFailure, localModelProcessEnvironment } from './processRunner'
import { localGpuTargetSupported, parseVulkanDevices, selectLocalExecution, type LocalRuntimeAcceleration } from './runtimeAcceleration'

test('Linux GPU targets and integrated Vulkan adapters require native hardware evidence', () => {
  assert.equal(localGpuTargetSupported('linux', 'x64'), true)
  assert.equal(localGpuTargetSupported('linux', 'arm64'), false)
  const devices = parseVulkanDevices('Vulkan0: Intel UHD (16000 MiB, 12000 MiB free)\nVulkan1: llvmpipe (16000 MiB, 12000 MiB free)',
    '0 = Intel UHD (Intel) | uma: 1 | fp16: 1\n1 = llvmpipe (LLVM) | uma: 1 | fp16: 1', true)
  assert.equal(devices.length, 1)
  assert.equal(devices[0].integrated, true)
  assert.equal(devices[0].name, 'Intel UHD')
  assert.equal(gpuDiagnosticFailure('error while loading shared libraries: libcublas.so.12: cannot open shared object file'), true)
  assert.equal(gpuDiagnosticFailure('error while loading shared libraries: unrelated.so: cannot open shared object file'), false)
})

test('Linux CUDA libraries are private to the GPU child process', { skip: process.platform !== 'linux' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-linux-loader-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const model = path.join(root, 'model'); await fs.writeFile(model, 'fixture')
  const inherited = process.env.LD_LIBRARY_PATH
  const execution = await selectLocalExecution('/cpu', model, 'translation', {
    policy: { mode: 'auto' }, devices: [{ id: 'GPU-loader', name: 'Loader fixture', backend: 'cuda', index: 0, memoryMiB: 16000 }],
    runtimes: { cuda: { translator: '/managed/cuda/llama-server', libraryDirectory: '/managed/dependencies' } }
  })
  try {
    assert.equal(execution.backend, 'cuda')
    assert.equal(execution.env.LD_LIBRARY_PATH, '/managed/cuda:/managed/cuda/lib:/managed/dependencies:/managed/dependencies/lib')
    assert.equal(execution.env.PATH, undefined)
    assert.equal(process.env.LD_LIBRARY_PATH, inherited)
  } finally { execution.release() }
})

test('Vulkan enumeration requires native discrete-memory evidence and excludes integrated/virtual adapters', () => {
  const devices = parseVulkanDevices('Vulkan0: RTX (16048 MiB, 15000 MiB free)\nVulkan1: Intel UHD (16000 MiB, 12000 MiB free)',
    'ggml_vulkan: 0 = RTX (NVIDIA) | uma: 0 | fp16: 1\nggml_vulkan: 1 = Intel UHD (Intel) | uma: 1 | fp16: 1')
  assert.deepEqual(devices.map(device => device.name), ['RTX'])
  assert.deepEqual(parseVulkanDevices('Vulkan0: Virtual (16000 MiB, 0 MiB free)', ''), [])
})
test('GPU diagnostics distinguish hardware/allocation failures from model errors and sanitize inherited overrides', () => {
  for (const message of ['CUDA error: out of memory', 'VK_ERROR_DEVICE_LOST', 'no usable GPU', 'CUDA driver version is insufficient']) assert.equal(gpuDiagnosticFailure(message), true)
  for (const message of ['invalid GGUF header', 'failed to load model', '任务已取消']) assert.equal(gpuDiagnosticFailure(message), false)
  assert.equal(gpuLoaderFailure(-1073741515), true)
  assert.equal(gpuLoaderFailure(0xc0000005), false, 'An arbitrary crash can be a corrupt model and is not proof of GPU failure')
  assert.deepEqual(localModelProcessEnvironment({ CUDA_VISIBLE_DEVICES: '0', GGML_VK_VISIBLE_DEVICES: '1', LLAMA_ARG_DEVICE: 'CUDA0', SAFE: 'yes' }), { SAFE: 'yes' })
})
test('automatic and explicit unavailable GPUs use a CPU executable without requiring any GPU library', async () => {
  for (const policy of [{ mode: 'auto' }, { mode: 'gpu', device: 'absent' }, { mode: 'cpu' }] as const) {
    const selected = await selectLocalExecution('/cpu', '/missing-weight', 'translation', { policy, devices: [], runtimes: {} })
    assert.equal(selected.executable, '/cpu')
    if (process.platform === 'darwin' && policy.mode === 'auto') assert.equal(selected.backend, 'metal')
    else assert.ok(selected.args.includes('none'))
    assert.ok(!selected.env.CUDA_VISIBLE_DEVICES)
  }
})

test('auto selects an installed backend and CUDA/Vulkan views share a bounded memory budget', { skip: !['win32', 'linux'].includes(process.platform) }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-gpu-budget-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const model = path.join(root, 'model.gguf'); await fs.writeFile(model, 'fixture')
  const devices = [
    { id: 'GPU-budget', name: 'Shared budget fixture', backend: 'cuda' as const, index: 0, memoryMiB: 5000 },
    { id: 'vulkan-budget', name: 'Shared budget fixture', backend: 'vulkan' as const, index: 0, memoryMiB: 5000 }
  ]
  const automatic: LocalRuntimeAcceleration = { policy: { mode: 'auto' }, devices, runtimes: { vulkan: { translator: '/vulkan' } } }
  const first = await selectLocalExecution('/cpu', model, 'translation', automatic)
  try {
    assert.equal(first.backend, 'vulkan', 'An absent CUDA package must not hide a working Vulkan backend')
    const second = await selectLocalExecution('/cpu', model, 'translation', { ...automatic, policy: { mode: 'gpu', device: devices[0].id }, runtimes: { cuda: { translator: '/cuda' } } })
    assert.equal(second.backend, 'cpu', 'The two backends must not reserve the same card twice')
    second.release()
  } finally { first.release() }
  const recovered = await selectLocalExecution('/cpu', model, 'translation', automatic)
  assert.equal(recovered.backend, 'vulkan'); recovered.release()
})
test('GPU startup retries once on CPU, but model errors and cancellation never do', { skip: !['win32', 'linux'].includes(process.platform) }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-gpu-fallback-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const model = path.join(root, 'model.gguf'); await fs.writeFile(model, 'fixture')
  for (const failure of ['gpu', 'model', 'zero-layers', 'cancel', 'success'] as const) {
    const launches: Array<{ executable: string; args: string[] }> = []
    const controller = new AbortController()
    let alive = false
    const launch = ((executable: string, args: string[]) => {
      launches.push({ executable, args }); alive = true
      const child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), exitCode: null as number | null, signalCode: null,
        kill() { alive = false; child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); return true } })
      queueMicrotask(() => {
        if (executable !== '/gpu') return
        if (failure === 'success') { child.stderr.write('load_tensors: offloaded 29/29 layers to GPU\n'); return }
        if (failure === 'zero-layers') return
        if (failure === 'cancel') { controller.abort(); return }
        child.stderr.write(failure === 'gpu' ? 'CUDA error: out of memory' : 'invalid GGUF header')
        alive = false; child.exitCode = 1; child.emit('exit', 1); child.emit('close', 1)
      })
      return child as unknown as ChildProcess
    }) as typeof spawn
    let reason = ''
    const acceleration: LocalRuntimeAcceleration = { policy: { mode: 'auto' }, devices: [{ id: 'GPU-fixture', name: 'Fixture', backend: 'cuda', index: 0, memoryMiB: 16000 }], runtimes: { cuda: { translator: '/gpu' } },
      status: (_, status) => { reason = status.reason ?? reason } }
    const engine = createLocalTextInference({ translator: '/cpu', translationModel: model, acceleration }, {
      spawn: launch, port: async () => 32105,
      request: async url => !alive ? new Response('', { status: 503 }) : String(url).endsWith('/v1/models') ? Response.json({ data: [] })
        : Response.json({ choices: [{ message: { content: '中文' }, finish_reason: 'stop' }] })
    })
    try {
      if (failure === 'model' || failure === 'cancel') {
        await assert.rejects(engine.translateText('テスト', controller.signal))
        assert.deepEqual(launches.map(value => value.executable), ['/gpu'])
      } else {
        assert.equal(await engine.translateText('テスト', controller.signal), '中文')
        assert.deepEqual(launches.map(value => value.executable), failure === 'success' ? ['/gpu'] : ['/gpu', '/cpu'])
        if (failure !== 'success') assert.ok(launches[1].args.includes('none'))
        if (failure === 'gpu') assert.match(reason, /显存/)
      }
    } finally { await engine.close() }
  }
})
