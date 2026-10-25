import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createQwenAsrRecognition, parseAudioCppVulkanDevices, parseQwenCues } from './qwenAsrRecognition'
import { createOfflineSubtitleInference } from './offlineInference'
import { createAiRuntimeInstaller } from '../../services/localModels/runtimeInstaller'
import { DEFAULT_LOCAL_MODEL_VARIANTS, localModelAssets } from '../../services/localModels/modelCatalog'
import { LocalModelProcessFailure, type runLocalModelProcess } from '../../services/localModels/processRunner'
import { createSubtitleCache } from './subtitleCache'
import { createSubtitleScheduler, type SubtitleSchedulerState } from './subtitleScheduler'

const target = { platform: 'win32', arch: 'x64' }
const word = (text: string, start: number, end: number) => ({ word: text, start_sample: start * 16000, end_sample: end * 16000 })

test('Qwen word offsets retain source-media time, Japanese punctuation and only the owning chunk', () => {
  const words = [word('前', 0, 1), word('今日', 3, 3.5), word('は', 3.5, 3.7), word('晴れ', 3.7, 4.5),
    word('明日', 5, 5.5), word('も', 5.5, 6), word('境界', 33, 34)]
  assert.deepEqual(parseQwenCues(words, '前。今日は晴れ。明日も。境界。', 27, 30, 60), [
    { start: 30, end: 31.5, japanese: '今日は晴れ。' }, { start: 32, end: 33, japanese: '明日も。' }
  ])
  assert.deepEqual(parseQwenCues([], '', 0, 0, 30), [])
  for (const text of ['…', '。。。', '！？', '♪ ♫', ' \n… ']) assert.deepEqual(parseQwenCues([], text, 27, 30, 60), [])
  assert.throws(() => parseQwenCues([word('異常', 2, 1)], '', 0, 0, 30), /时间戳/)
  assert.throws(() => parseQwenCues([word('異常', 0, 40)], '', 0, 0, 30), /时间戳/)
  assert.throws(() => parseQwenCues([word('後', 2, 3), word('前', 0, 1)], '', 0, 0, 30), /时间戳/)
  assert.throws(() => parseQwenCues([], '未对齐', 0, 0, 30), /时间戳/)
})

test('Qwen rejects incomplete text coverage and zero-duration speech instead of silently dropping words', () => {
  assert.throws(() => parseQwenCues([word('今日', 0, 1)], '今日は晴れ。', 0, 0, 30), /完整覆盖/)
  assert.throws(() => parseQwenCues([word('今日', 0, 0)], '今日。', 0, 0, 30), /时长/)
  assert.deepEqual(parseQwenCues([word('Ａ', 0, 1)], 'A。', 0, 0, 30).length, 1)
  assert.deepEqual(parseQwenCues([word('境界', 2, 4)], '境界。', 27, 30, 60), [{ start: 29, end: 31, japanese: '境界。' }])
})

test('Qwen cue grouping splits long speech and preserves pauses instead of translating each word', () => {
  const words = Array.from({ length: 15 }, (_, i) => word('あいうえお', i / 2, i / 2 + 0.4))
  const cues = parseQwenCues(words, '', 0, 0, 30)
  assert.ok(cues.length > 1 && cues.length < words.length)
  assert.ok(cues.every(cue => cue.japanese.length <= 44 && cue.end - cue.start <= 7))
  assert.equal(cues.map(cue => cue.japanese).join(''), words.map(word => word.word).join(''))
})

test('audio.cpp device parsing requires hardware evidence for discrete and integrated adapters', () => {
  const output = 'Vulkan:0 "Discrete" [GPU]\nVulkan:1 "Integrated" [IGPU]\nCPU:0 "CPU" [CPU]\n'
  assert.deepEqual(parseAudioCppVulkanDevices(output, 'Discrete | uma: 0 | fp16: 1\nIntegrated | uma: 1'), [{ index: 0, name: 'Discrete' }, { index: 1, name: 'Integrated', integrated: true }])
  assert.deepEqual(parseAudioCppVulkanDevices(output, 'backend=vulkan'), [])
})

test('Qwen uses the existing extraction pipeline and exposes timed cues without invoking Kotoba or translation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-qwen-subtitles-'))
  const calls: string[][] = []
  const run: typeof runLocalModelProcess = async (executable, args) => {
    calls.push([executable, ...args])
    if (args.includes('-c:a')) await fs.writeFile(args.at(-1)!, 'wav')
    else {
      assert.match(args[args.indexOf('--model') + 1], /qwen3-asr-1\.7b-ja-anime-galgame[\\/]jaykwok[\\/][a-f0-9]{40}[\\/]BF16$/)
      assert.equal(args[args.indexOf('--backend') + 1], 'cpu')
      assert.ok(args.some(arg => arg.startsWith('qwen3_asr.forced_aligner_path=')))
      await fs.writeFile(args[args.indexOf('--text-out') + 1], '今日は晴れ。')
      await fs.writeFile(args[args.indexOf('--words-out') + 1], JSON.stringify([word('今日', 3, 3.5), word('は', 3.5, 3.7), word('晴れ', 3.7, 4.5)]))
    }
    return ''
  }
  const paths = createAiRuntimeInstaller(root, undefined, localModelAssets(DEFAULT_LOCAL_MODEL_VARIANTS, undefined, target), { target, recognitionModel: 'qwen3-asr' }).paths()
  const inference = createOfflineSubtitleInference(paths, path.join(root, 'work'), { run })
  try {
    assert.deepEqual(await inference.recognize('authorized-resource', 2, 30, 60, new AbortController().signal),
      [{ start: 30, end: 31.5, japanese: '今日は晴れ。' }])
    assert.equal(calls.length, 2)
    assert.ok(calls[0].includes('0:2'))
    assert.equal(calls[0][calls[0].indexOf('-ss') + 1], '27')
    assert.deepEqual(await fs.readdir(path.join(root, 'work')), [])
  } finally { await inference.close(); await fs.rm(root, { recursive: true, force: true }) }
})

test('disabling ForcedAligner runs ASR alone without overlap, aligner files or word timestamps', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-qwen-unaligned-'))
  const paths = createAiRuntimeInstaller(root, undefined, localModelAssets(DEFAULT_LOCAL_MODEL_VARIANTS, undefined, target), { target, recognitionModel: 'qwen3-asr', qwenForcedAligner: false }).paths()
  const device = { id: 'gpu', name: 'Discrete', backend: 'vulkan' as const, index: 0, memoryMiB: 16384 }
  paths.acceleration = { policy: { mode: 'gpu', device: device.id }, devices: [device], runtimes: { vulkan: { audiocpp: 'gpu.exe' } } }
  await fs.mkdir(path.dirname(paths.qwenAsr!.model), { recursive: true }); await fs.writeFile(paths.qwenAsr!.model, 'weight')
  const requests: string[][] = []
  const logs: unknown[] = []
  const inference = createOfflineSubtitleInference(paths, path.join(root, 'work'), { log: (stage, value) => logs.push([stage, value]), run: async (_executable, args, options) => {
    if (args.includes('--list-devices')) { options?.diagnostic?.('Discrete | uma: 0'); return 'Vulkan:0 "Discrete" [GPU]\n' }
    requests.push([...args])
    if (args.includes('-c:a')) await fs.writeFile(args.at(-1)!, 'wav')
    else {
      assert.equal(args[args.indexOf('--backend') + 1], 'vulkan', 'no missing-aligner stat should force CPU fallback')
      assert.equal(args.some(arg => arg.includes('forced_aligner')), false)
      assert.equal(args.includes('--words-out'), false)
      await fs.writeFile(args[args.indexOf('--text-out') + 1], '日本語の識別。')
    }
    return ''
  } })
  try {
    for (const start of [30, 60]) assert.deepEqual(await inference.recognize('fixture', 2, start, start + 30, new AbortController().signal),
      [{ start, end: start + 30, japanese: '日本語の識別。' }])
    for (const [index, start] of [[0, 30], [2, 60]]) {
      assert.equal(requests[index][requests[index].indexOf('-ss') + 1], String(start))
      assert.equal(requests[index][requests[index].indexOf('-t') + 1], '30')
    }
    assert.match(JSON.stringify(logs), /未对齐/)
    assert.deepEqual(await fs.readdir(path.join(root, 'work')), [])
  } finally { await inference.close(); await fs.rm(root, { recursive: true, force: true }) }
})

test('Qwen cancellation and invalid model failures never switch to Kotoba or another model', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-qwen-failure-'))
  const paths = createAiRuntimeInstaller(root, undefined, localModelAssets(DEFAULT_LOCAL_MODEL_VARIANTS, undefined, target), { target, recognitionModel: 'qwen3-asr' }).paths()
  let calls = 0
  const recognize = createQwenAsrRecognition(paths, async () => { calls++; throw new LocalModelProcessFailure('audiocpp_cli.exe', 1) })
  try {
    await assert.rejects(recognize('input.wav', 'result', 0, 0, 30, new AbortController().signal), LocalModelProcessFailure)
    assert.equal(calls, 1)
    await assert.rejects(recognize('input.wav', 'result', 0, 0, 30, AbortSignal.abort()), { name: 'AbortError' })
    assert.equal(calls, 1)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('punctuation-only ASR output with an empty alignment does not prevent the next speech chunk', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-qwen-punctuation-'))
  const paths = createAiRuntimeInstaller(root, undefined, localModelAssets(DEFAULT_LOCAL_MODEL_VARIANTS, undefined, target), { target, recognitionModel: 'qwen3-asr' }).paths()
  let calls = 0
  const recognize = createQwenAsrRecognition(paths, async (_executable, args) => {
    const silent = calls++ === 0
    await fs.writeFile(args[args.indexOf('--text-out') + 1], silent ? '…\r\n' : '日本語。')
    await fs.writeFile(args[args.indexOf('--words-out') + 1], JSON.stringify(silent ? [] : [word('日本語', 3, 4)]))
    return ''
  })
  try {
    assert.deepEqual(await recognize('input.wav', path.join(root, 'silent'), 27, 30, 60, new AbortController().signal), [])
    assert.deepEqual(await recognize('input.wav', path.join(root, 'speech'), 57, 60, 90, new AbortController().signal),
      [{ start: 60, end: 61, japanese: '日本語。' }])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('audio.cpp can omit the words file for empty transcripts and subsequent speech still aligns', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-qwen-empty-output-'))
  const paths = createAiRuntimeInstaller(root, undefined, localModelAssets(DEFAULT_LOCAL_MODEL_VARIANTS, undefined, target), { target, recognitionModel: 'qwen3-asr' }).paths()
  const transcripts = ['', '\r\n', '…\r\n', '日本語。']
  let calls = 0
  const recognize = createQwenAsrRecognition(paths, async (_executable, args) => {
    const transcript = transcripts[calls++]
    await fs.writeFile(args[args.indexOf('--text-out') + 1], transcript)
    if (transcript === '日本語。') await fs.writeFile(args[args.indexOf('--words-out') + 1], JSON.stringify([word('日本語', 3, 4)]))
    return ''
  })
  try {
    for (let index = 0; index < 3; index++) assert.deepEqual(await recognize('input.wav', path.join(root, `empty-${index}`), 27, 30, 60, new AbortController().signal), [])
    assert.deepEqual(await recognize('input.wav', path.join(root, 'speech'), 57, 60, 90, new AbortController().signal),
      [{ start: 60, end: 61, japanese: '日本語。' }])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('missing word timestamps for speech and malformed outputs remain errors', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-qwen-missing-output-'))
  const paths = createAiRuntimeInstaller(root, undefined, localModelAssets(DEFAULT_LOCAL_MODEL_VARIANTS, undefined, target), { target, recognitionModel: 'qwen3-asr' }).paths()
  try {
    const missing = createQwenAsrRecognition(paths, async (_executable, args) => {
      await fs.writeFile(args[args.indexOf('--text-out') + 1], '日本語。')
      return ''
    })
    await assert.rejects(missing('input.wav', path.join(root, 'speech'), 0, 0, 30, new AbortController().signal), { code: 'ENOENT' })
    const malformed = createQwenAsrRecognition(paths, async (_executable, args) => {
      await fs.writeFile(args[args.indexOf('--text-out') + 1], '')
      await fs.writeFile(args[args.indexOf('--words-out') + 1], '{')
      return ''
    })
    await assert.rejects(malformed('input.wav', path.join(root, 'malformed'), 0, 0, 30, new AbortController().signal), SyntaxError)
    await assert.rejects(createQwenAsrRecognition(paths, async () => '')('input.wav', path.join(root, 'missing-text'), 0, 0, 30, new AbortController().signal), { code: 'ENOENT' })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('the logged empty-transcript case completes its cache chunk and continues without a subtitle failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-qwen-empty-chunk-'))
  const paths = createAiRuntimeInstaller(root, undefined, localModelAssets(DEFAULT_LOCAL_MODEL_VARIANTS, undefined, target), { target, recognitionModel: 'qwen3-asr' }).paths()
  let calls = 0
  const inference = createOfflineSubtitleInference(paths, path.join(root, 'work'), { run: async (_executable, args) => {
    if (args.includes('-c:a')) await fs.writeFile(args.at(-1)!, 'wav')
    else {
      const empty = calls++ === 0
      await fs.writeFile(args[args.indexOf('--text-out') + 1], empty ? '\r\n' : '日本語。')
      if (!empty) await fs.writeFile(args[args.indexOf('--words-out') + 1], JSON.stringify([word('日本語', 3, 4)]))
    }
    return ''
  } })
  const cache = createSubtitleCache(path.join(root, 'cache'), 'a'.repeat(64))
  const states: SubtitleSchedulerState[] = [], failures: unknown[] = []
  const scheduler = createSubtitleScheduler(60, {
    read: index => cache.read(index), write: chunk => cache.write(chunk),
    recognize: (start, end, signal) => inference.recognize('fixture', 1, start, end, signal),
    translate: async cues => cues.map(cue => ({ ...cue, chinese: '日语。' })),
    changed: value => states.push(value), failed: (_index, _stage, cause) => failures.push(cause)
  })
  try {
    scheduler.start()
    for (let attempt = 0; attempt < 200 && states.at(-1)?.translatedSeconds !== 60; attempt++) await delay(5)
    assert.equal(states.at(-1)?.translatedSeconds, 60)
    assert.equal(states.at(-1)?.error, null)
    assert.deepEqual(failures, [])
    assert.deepEqual(await cache.read(0), { index: 0, translated: true, cues: [] })
    assert.equal((await cache.read(1))?.cues[0].japanese, '日本語。')
  } finally { await scheduler.stop(); await inference.close(); await fs.rm(root, { recursive: true, force: true }) }
})

test('Qwen GPU failure retries the same ASR and aligner on CPU once and retains CPU for later chunks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-qwen-gpu-fallback-'))
  const paths = createAiRuntimeInstaller(root, undefined, localModelAssets(DEFAULT_LOCAL_MODEL_VARIANTS, undefined, target), { target, recognitionModel: 'qwen3-asr' }).paths()
  const device = { id: 'GPU-selected', name: 'Discrete', index: 0, memoryMiB: 16384, backend: 'cuda' as const }
  const execution: string[] = [], backends: string[] = []
  paths.acceleration = { policy: { mode: 'gpu', device: device.id }, devices: [device], runtimes: { vulkan: { audiocpp: 'gpu.exe' } },
    status: (_engine, value) => { execution.push(value.backend) } }
  for (const file of [paths.qwenAsr!.model, paths.qwenAsr!.aligner]) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'weight') }
  const run: typeof runLocalModelProcess = async (_executable, args, options) => {
    if (args.includes('--list-devices')) { options?.diagnostic?.('Discrete | uma: 0'); return 'Vulkan:0 "Discrete" [GPU]\n' }
    const backend = args[args.indexOf('--backend') + 1]; backends.push(backend)
    assert.equal(args[args.indexOf('--model') + 1], path.dirname(paths.qwenAsr!.model))
    if (backend === 'vulkan') throw new LocalModelProcessFailure('gpu.exe', 1, true)
    await fs.writeFile(args[args.indexOf('--text-out') + 1], '日本語。')
    await fs.writeFile(args[args.indexOf('--words-out') + 1], JSON.stringify([word('日本語', 0, 1)]))
    return ''
  }
  const recognize = createQwenAsrRecognition(paths, run)
  try {
    for (let i = 0; i < 2; i++) assert.equal((await recognize('input.wav', path.join(root, 'result'), 0, 0, 30, new AbortController().signal))[0].japanese, '日本語。')
    assert.deepEqual(backends, ['vulkan', 'cpu', 'cpu'])
    assert.deepEqual(execution, ['cpu', 'cpu'])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
