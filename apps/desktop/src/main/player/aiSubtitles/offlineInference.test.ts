import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess, spawn, SpawnOptions } from 'node:child_process'
import type { LocalTranslationModelId } from '@shared/desktop/localModels'
import { createOfflineSubtitleInference } from './offlineInference'
import { createAiRuntimeInstaller } from '../../services/localModels/runtimeInstaller'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LocalModelProcessFailure } from '../../services/localModels/processRunner'

function fixture(model: LocalTranslationModelId, result: unknown = '中文译文', finishReason = 'stop') {
  const logs: Array<{ stage: string; value: unknown }> = []
  const launches: Array<{ executable: string; args: string[]; options: SpawnOptions }> = []
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  let kills = 0
  const launch = ((executable: string, args: string[], options: SpawnOptions) => {
    launches.push({ executable, args, options })
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null,
      kill() { if (child.exitCode === null) { kills++; child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0) }; return true } })
    return child as unknown as ChildProcess
  }) as typeof spawn
  const request: typeof fetch = async (input, init) => {
    const url = String(input), token = launches.at(-1)!.options.env!.LLAMA_API_KEY
    assert.match(token!, /^[a-f0-9]{64}$/)
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`)
    assert.equal(new URL(url).origin, 'http://127.0.0.1:32101')
    if (url.endsWith('/v1/models')) return Response.json({ data: [] })
    assert.ok(url.endsWith('/v1/chat/completions'))
    requests.push({ url, body: JSON.parse(String(init?.body)) })
    return Response.json({ choices: [{ message: { content: result }, finish_reason: finishReason }] })
  }
  const paths = { ...createAiRuntimeInstaller('/fixture').paths(), translationModelId: model }
  const inference = createOfflineSubtitleInference(paths, '/work', { spawn: launch, request, port: async () => 32101,
    log: (stage, value) => logs.push({ stage, value }) })
  return { inference, launches, requests, logs, kills: () => kills }
}

test('recognition retries a failed GPU chunk once on CPU and retains CPU for later chunks', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-asr-gpu-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const model = path.join(root, 'model.bin'); await fs.writeFile(model, 'fixture')
  const launches: Array<{ executable: string; args: string[] }> = []
  const inference = createOfflineSubtitleInference({ ...createAiRuntimeInstaller(root).paths(), kotoba: model, whisper: '/cpu-asr', ffmpeg: '/extract',
    acceleration: { policy: { mode: 'auto' }, devices: [{ id: 'GPU-fixture', name: 'Fixture', backend: 'cuda', index: 0, memoryMiB: 16000 }], runtimes: { cuda: { whisper: '/gpu-asr' } } }
  }, path.join(root, 'work'), { run: async (executable, args) => {
    if (executable === '/extract') { await fs.writeFile(args.at(-1)!, 'wav'); return '' }
    launches.push({ executable, args })
    if (executable === '/gpu-asr') throw new LocalModelProcessFailure('whisper', 1, true)
    assert.ok(args.includes('--no-gpu'))
    const output = args[args.indexOf('-of') + 1]
    await fs.writeFile(`${output}.json`, JSON.stringify({ transcription: [{ offsets: { from: 4000, to: 5000 }, text: 'こんにちは' }] }))
    return ''
  } })
  try {
    const signal = new AbortController().signal
    assert.equal((await inference.recognize('/sample', 0, 0, 20, signal)).length, 1)
    await inference.recognize('/sample', 0, 20, 40, signal)
    assert.deepEqual(launches.map(value => value.executable), ['/gpu-asr', '/cpu-asr', '/cpu-asr'])
    assert.deepEqual(await fs.readdir(path.join(root, 'work')), [])
  } finally { await inference.close() }
})

test('recognition never retries corrupt models or user cancellation on CPU', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-asr-no-retry-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const model = path.join(root, 'model.bin'); await fs.writeFile(model, 'fixture')
  for (const cancel of [false, true]) {
    const launches: string[] = [], controller = new AbortController()
    const inference = createOfflineSubtitleInference({ ...createAiRuntimeInstaller(root).paths(), kotoba: model, whisper: '/cpu', ffmpeg: '/extract',
      acceleration: { policy: { mode: 'auto' }, devices: [{ id: 'GPU-fixture', name: 'Fixture', backend: 'cuda', index: 0, memoryMiB: 16000 }], runtimes: { cuda: { whisper: '/gpu' } } }
    }, path.join(root, 'work'), { run: async (executable, args) => {
      if (executable === '/extract') { await fs.writeFile(args.at(-1)!, 'wav'); return '' }
      launches.push(executable)
      if (cancel) controller.abort()
      throw new LocalModelProcessFailure('whisper', 1, cancel)
    } })
    try {
      await assert.rejects(inference.recognize('/sample', 0, 0, 20, controller.signal))
      assert.deepEqual(launches, ['/gpu'])
      assert.deepEqual(await fs.readdir(path.join(root, 'work')), [])
    } finally { await inference.close() }
  }
})

for (const model of ['qwen3', 'hy-mt2-7b'] as const) {
  test(`${model} serializes owned offline text and subtitle requests with its own model policy`, async () => {
    const f = fixture(model)
    try {
      assert.equal(await f.inference.translateText('ABC-123: $10', new AbortController().signal), '中文译文')
      const updates: unknown[] = []
      const cues = await f.inference.translate([
        { start: 0, end: 2, japanese: 'もう翻訳済み', chinese: '已翻译' },
        { start: 2, end: 4, japanese: 'はい' }
      ], new AbortController().signal, async value => { updates.push(value) })
      assert.deepEqual(cues.map(cue => cue.chinese), ['已翻译', '中文译文'])
      assert.equal(updates.length, 1)
      assert.equal(f.launches.length, 1, 'one owned translator is reused')
      const launch = f.launches[0]
      assert.ok(launch.args.includes('--offline'))
      assert.ok(launch.args.includes('--no-webui'))
      assert.ok(launch.args.includes('--no-agent'))
      assert.equal(launch.args.includes('--jinja'), model !== 'qwen3')
      assert.equal(launch.args.includes('--override-kv'), model === 'hy-mt2-7b')
      assert.equal(launch.options.shell, false)
      assert.equal(launch.options.windowsHide, true)
      assert.equal(Object.keys(launch.options.env!).some(key => /^(HF_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)/i.test(key)), false)
      assert.deepEqual(f.requests.map(request => request.body.max_tokens), [1536, 768])
      for (const { body } of f.requests) {
        assert.equal(body.stream, false)
        assert.equal(body.top_p, model === 'hy-mt2-7b' ? 0.6 : 0.8)
        assert.equal(body.temperature, 0.7)
        assert.equal(body.chat_template_kwargs === undefined, model === 'hy-mt2-7b')
        assert.deepEqual(body.stop, model === 'hy-mt2-7b' ? ['<|eos|>', '<|extra_5|>'] : undefined)
        assert.equal((body.messages as Array<{ role: string }>)[0].role, 'user')
      }
      const message = (f.requests[1].body.messages as Array<{ content: string }>)[0].content
      assert.match(message, /不要翻译这些句子：\nもう翻訳済み/)
      assert.ok(message.endsWith('はい'))
    } finally { await f.inference.close() }
    assert.equal(f.kills(), 1)
  })
}

test('HY rejects empty, oversized and truncated responses without accepting partial translations', async () => {
  for (const [content, reason] of [['', 'stop'], ['中文', 'length'], ['文'.repeat(6001), 'stop']] as const) {
    const f = fixture('hy-mt2-7b', content, reason)
    try { await assert.rejects(f.inference.translateText('日本語', new AbortController().signal), /译文不完整/) }
    finally { await f.inference.close() }
  }
})

test('an already cancelled HY request never starts a translator', async () => {
  const f = fixture('hy-mt2-7b'), signal = AbortSignal.abort()
  try {
    await assert.rejects(f.inference.translateText('日本語', signal), { name: 'AbortError' })
    assert.equal(f.launches.length, 0)
  } finally { await f.inference.close() }
})


test('diagnostics preserve raw rejected output and prompt without request credentials', async () => {
  const f = fixture('qwen3', '尚未完成的译文', 'length')
  try {
    await assert.rejects(f.inference.translateText('日本語', new AbortController().signal), /译文不完整/)
    const text = JSON.stringify(f.logs)
    assert.match(text, /日本語/)
    assert.match(text, /尚未完成的译文/)
    assert.match(text, /length/)
    assert.equal(text.includes(f.launches[0].options.env!.LLAMA_API_KEY!), false)
    assert.equal(text.includes('127.0.0.1'), false)
  } finally { await f.inference.close() }
})
