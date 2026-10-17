import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { PlaybackSnapshot } from '@shared/desktop/playback'
import type { NativePlayback } from '../nativePlayback'
import type { PlaybackSource } from '../playbackSource'
import { createAiSubtitleController } from './aiSubtitleController'
import { createAiRuntimeInstaller, type AiRuntimePaths } from '../../services/localModels/runtimeInstaller'
import { createOfflineSubtitleInference } from './offlineInference'

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await delay(5) }
  assert.fail('controller did not reach expected state')
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-ai-controller-'))
  let playback = { sessionId: 'one', phase: 'playing', seekable: true, duration: 15, position: 0,
    tracks: [{ type: 'sub', id: 8, title: null, language: null, codec: null, channelCountHint: null, selected: true }] } as PlaybackSnapshot
  let audio = 1, closeCount = 0, recognizeCount = 0, translateCount = 0, selected = false, subtitleErrors = 0
  let failUpdate = false
  let asrVersion = 'asr-original', translationVersion = 'qwen-original'
  let leases = 0, finishClose = async (): Promise<void> => {}
  let finishUpdate = async (): Promise<void> => {}
  let finishRemoval = async (): Promise<void> => {}
  let prepareStream = async (index: number, _signal: AbortSignal) => ({ index, identity: `audio-${index}` })
  let finishRecognition = async (signal: AbortSignal): Promise<void> => { await delay(5, undefined, { signal }) }
  let acquire = async (): Promise<void> => {}
  let installed = async () => true, runtimeChanged = (): void => {}
  const updates: Array<{ filename: string; select: boolean }> = [], removals: Array<number | null> = []
  const logs: string[] = []
  const source: PlaybackSource = { target: { libraryId: 1, videoId: 1, resourceId: 1 }, mode: 'remote',
    locator: 'https://fixture.invalid/grant?secret=original', identityKey: 'fixture', revision: 'one', resumeKey: 'one', title: 'fixture' }
  const native: NativePlayback = { create: () => {}, load: () => {}, command: () => {}, read: () => ({ alive: true }),
    viewport: () => {}, render: () => {}, addSubtitle: () => {}, destroy: () => {},
    selectedAudioStream: () => audio, generatedSubtitleSelected: () => selected,
    subtitleCommandErrors: () => subtitleErrors,
    updateGeneratedSubtitle: async (filename: string, select: boolean) => {
      updates.push({ filename, select })
      if (select) {
        selected = true
        playback = { ...playback, tracks: [{ type: 'sub', id: 9, title: 'AI', language: null, codec: null, channelCountHint: null, selected: true }] }
      }
      await finishUpdate()
      if (failUpdate) { failUpdate = false; subtitleErrors++; throw new Error('fixture generated subtitle failure') }
    },
    removeGeneratedSubtitle: async (_: string, restore: number | null) => {
      await finishRemoval()
      removals.push(restore); selected = false
      playback = { ...playback, tracks: [{ type: 'sub', id: 8, title: null, language: null, codec: null, channelCountHint: null, selected: restore === 8 }] }
    }
  }
  const base = createAiRuntimeInstaller(path.join(root, 'models'))
  const runtime = { ...base, installed: () => installed(), paths: () => ({ ...base.paths(), asrVersion, translationVersion }) }
  let resolve = async (value: PlaybackSource) => ({ ...value, locator: 'https://fixture.invalid/grant?secret=renewed' })
  const controller = createAiSubtitleController({ root, runtime, native, playback: () => playback,
    source: () => source, resolve: value => resolve(value), changed: () => {}, exportFile: async () => {},
    openLog: async content => { logs.push(content) },
    acquireRuntime: async () => { await acquire(); leases++; return () => { leases-- } },
    onRuntimeChanged: listener => { runtimeChanged = listener; return () => { runtimeChanged = () => {} } },
    inference: ((paths: AiRuntimePaths) => ({
      probe: async (_: string, index: number, signal: AbortSignal) => prepareStream(index, signal),
      recognize: async (locator: string, index: number, start: number, end: number, signal: AbortSignal) => {
        assert.ok(locator.includes('renewed')); recognizeCount++
        await finishRecognition(signal)
        return [{ start, end, japanese: `音轨${index}` }]
      },
      translate: async cues => { translateCount++; return cues.map(cue => ({ ...cue, chinese: `译文-${paths.translationVersion}` })) },
      translateText: async () => '译文',
      close: async () => { closeCount++; await finishClose() }
    })) as typeof createOfflineSubtitleInference
  })
  return { controller, root, updates, removals, logs, setAudio: (value: number) => { audio = value },
    setSession: () => { playback = { ...playback, sessionId: 'two' } },
    setResolve: (value: typeof resolve) => { resolve = value }, tick: () => controller.tick(playback),
    recognizes: () => recognizeCount, translations: () => translateCount, closes: () => closeCount,
    failSubtitleCommand: () => { failUpdate = true }, failManualSubtitleCommand: () => { subtitleErrors++ }, playback: () => playback,
    setInstalled: (read: typeof installed) => { installed = read }, runtimeChanged: () => runtimeChanged(),
    setVersions: (asr: string, translation: string) => { asrVersion = asr; translationVersion = translation },
    leases: () => leases, setClose: (value: typeof finishClose) => { finishClose = value },
    setUpdate: (value: typeof finishUpdate) => { finishUpdate = value },
    setRemoval: (value: typeof finishRemoval) => { finishRemoval = value },
    setProbe: (value: typeof prepareStream) => { prepareStream = value },
    setRecognition: (value: typeof finishRecognition) => { finishRecognition = value },
    setAcquire: (value: typeof acquire) => { acquire = value },
    setDuration: (duration: number) => { playback = { ...playback, duration } },
    cleanup: async () => { await controller.close(); await fs.rm(root, { recursive: true, force: true }) }
  }
}

test('changing audio during preparation cancels the old probe and starts the latest stream', async () => {
  const f = await fixture()
  let oldSignal: AbortSignal | null = null
  let release!: () => void
  f.setProbe(async (index, signal) => {
    if (index === 1) {
      oldSignal = signal
      await new Promise<void>(resolve => { release = resolve; signal.addEventListener('abort', resolve.bind(null, undefined), { once: true }) })
      signal.throwIfAborted()
    }
    return { index, identity: `audio-${index}` }
  })
  let starting: Promise<unknown> | undefined
  try {
    starting = f.controller.command('one', { action: 'start' })
    await until(() => oldSignal !== null)
    f.setAudio(2); f.tick()
    await delay(20)
    assert.equal(oldSignal!.aborted, true, 'preparing must not suppress an audio-track restart')
    await until(() => f.recognizes() === 1 && f.controller.snapshot().translatedSeconds === 15)
    assert.match(await fs.readFile(f.updates.at(-1)!.filename, 'utf8'), /音轨2/)
  } finally { release?.(); await starting; await f.cleanup() }
})

test('stopping preserves the ASS file until native removal completes', async () => {
  const f = await fixture()
  let release!: () => void, removing = false
  f.setRemoval(() => new Promise<void>(resolve => { removing = true; release = resolve }))
  let stopped: Promise<unknown> | undefined
  try {
    await f.controller.command('one', { action: 'start' })
    await until(() => f.updates.length > 0)
    const filename = f.updates[0].filename
    stopped = f.controller.command('one', { action: 'stop' })
    await until(() => removing)
    assert.equal(await fs.access(filename).then(() => true, () => false), true)
    assert.equal(f.leases(), 1)
    release(); await stopped
    assert.equal(await fs.access(filename).then(() => true, () => false), false)
    assert.equal(f.leases(), 0)
  } finally { release?.(); await stopped; await f.cleanup() }
})

test('translator cleanup failure still removes display files and releases the model lease', async () => {
  const f = await fixture()
  try {
    await f.controller.command('one', { action: 'start' })
    await until(() => f.updates.length > 0)
    const filename = f.updates[0].filename
    f.setClose(async () => { throw new Error('fixture translator cleanup failure') })
    await f.controller.command('one', { action: 'stop' })
    assert.equal(f.leases(), 0)
    assert.deepEqual(f.removals, [8])
    assert.equal(await fs.access(filename).then(() => true, () => false), false)
  } finally { await f.cleanup() }
})

test('starting during cache deletion waits until deletion has settled', async t => {
  const f = await fixture()
  const remove = fs.rm
  let release!: () => void, deleting = false
  const gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(fs, 'rm', async (filename: Parameters<typeof fs.rm>[0], options: Parameters<typeof fs.rm>[1]) => {
    if (options?.recursive && typeof filename === 'string' && filename.startsWith(path.join(f.root, 'cache') + path.sep)) { deleting = true; await gate }
    await remove(filename, options)
  })
  let cleared: Promise<unknown> | undefined, started: Promise<unknown> | undefined
  try {
    await f.controller.command('one', { action: 'start' })
    await until(() => f.controller.snapshot().translatedSeconds === 15)
    cleared = f.controller.command('one', { action: 'clear-cache' })
    await until(() => deleting)
    started = f.controller.command('one', { action: 'start' })
    await delay(20)
    assert.equal(f.leases(), 0)
    assert.equal(f.controller.snapshot().enabled, false)
    release(); await Promise.all([cleared, started])
    await until(() => f.recognizes() === 2 && f.controller.snapshot().translatedSeconds === 15)
  } finally { release(); await Promise.all([cleared, started]); await f.cleanup() }
})

test('stop aborts active recognition before waiting for translator shutdown', async () => {
  const f = await fixture()
  let signal: AbortSignal | null = null
  let releaseClose!: () => void
  f.setRecognition(async value => {
    signal = value
    await new Promise<void>(resolve => { value.addEventListener('abort', resolve.bind(null, undefined), { once: true }) })
    value.throwIfAborted()
  })
  f.setClose(() => new Promise<void>(resolve => { releaseClose = resolve }))
  let stopping: Promise<unknown> | undefined
  try {
    await f.controller.command('one', { action: 'start' })
    await until(() => signal !== null)
    stopping = f.controller.command('one', { action: 'stop' })
    await until(() => f.closes() === 1)
    assert.equal(signal!.aborted, true, 'recognition must be cancelled before any asynchronous cleanup wait')
  } finally { releaseClose?.(); await stopping; f.setClose(async () => {}); await f.cleanup() }
})

test('a playback replacement during runtime acquisition cannot start an old subtitle session', async () => {
  const f = await fixture()
  let release!: () => void, acquiring = false
  f.setAcquire(() => new Promise<void>(resolve => { acquiring = true; release = resolve }))
  try {
    const starting = f.controller.command('one', { action: 'start' }).catch(() => {})
    await until(() => acquiring)
    f.setSession(); release(); await starting
    assert.equal(f.controller.snapshot().enabled, false)
    assert.equal(f.leases(), 0)
    assert.equal(f.recognizes(), 0)
  } finally { release?.(); await f.cleanup() }
})

test('starting subtitles for a replacement playback does not wait for the next polling tick', async () => {
  const f = await fixture()
  try {
    await f.controller.command('one', { action: 'start' })
    await until(() => f.controller.snapshot().translatedSeconds === 15)
    f.setSession()
    await assert.rejects(f.controller.command('two', { action: 'clear-cache' }), /当前播放会话没有/)
    await f.controller.command('two', { action: 'start' })
    await until(() => f.controller.snapshot().sessionId === 'two' && f.controller.snapshot().translatedSeconds === 15)
    assert.equal(f.controller.snapshot().enabled, true)
    assert.equal(f.leases(), 1)
  } finally { await f.cleanup() }
})

test('retry during a pending display update is retained even when the document has not changed', async () => {
  const f = await fixture()
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  f.setUpdate(() => pending)
  try {
    await f.controller.command('one', { action: 'start' })
    await until(() => f.updates.length === 1 && f.controller.snapshot().translatedSeconds === 15)
    await f.controller.command('one', { action: 'retry' })
    release()
    await until(() => f.updates.length > 1)
    assert.equal(f.updates.at(-1)!.select, true)
    assert.equal(f.recognizes(), 1)
  } finally { release?.(); await f.cleanup() }
})

test('pending native refresh coalesces later cues and display changes into the latest document', async () => {
  const f = await fixture()
  let release!: () => void
  const loading = new Promise<void>(resolve => { release = resolve })
  f.setDuration(90)
  f.setUpdate(() => loading)
  try {
    await f.controller.command('one', { action: 'start' })
    await until(() => f.updates.length === 1 && f.controller.snapshot().translatedSeconds === 90)
    await f.controller.command('one', { action: 'display', value: 'chinese' })
    await f.controller.command('one', { action: 'font-size', value: 54 })
    assert.equal(f.updates.length, 1, 'no new update while the native reader is still loading')
    release()
    await until(() => f.updates.length === 2)
    const document = await fs.readFile(f.updates[1].filename, 'utf8')
    assert.match(document, /0:01:30\.00/)
    assert.match(document, /译文-qwen-original/)
    assert.doesNotMatch(document, /音轨1/)
    assert.match(document, /,54,/)
    await delay(20)
    assert.equal(f.updates.length, 2, 'intermediate requests are coalesced rather than replayed')
    assert.equal(f.controller.snapshot().error, null)
  } finally { release(); await f.cleanup() }
})

test('stop waits for an in-flight native load before removing the generated subtitle', async () => {
  const f = await fixture()
  let release!: () => void
  f.setUpdate(() => new Promise<void>(resolve => { release = resolve }))
  try {
    await f.controller.command('one', { action: 'start' })
    await until(() => f.updates.length === 1)
    const stopped = f.controller.command('one', { action: 'stop' })
    await delay(20)
    assert.deepEqual(f.removals, [])
    release()
    await stopped
    assert.deepEqual(f.removals, [8])
    assert.equal(f.controller.snapshot().enabled, false)
  } finally { release?.(); await f.cleanup() }
})

test('logs remain readable after stopping but do not leak into another playback session', async () => {
  const f = await fixture()
  try {
    await f.controller.command('one', { action: 'start' })
    await until(() => f.controller.snapshot().translatedSeconds === 15)
    await f.controller.command('one', { action: 'stop' })
    await f.controller.command('one', { action: 'view-log' })
    assert.match(f.logs.at(-1)!, /开始 AI 字幕/)
    assert.doesNotMatch(f.logs.at(-1)!, /secret=|fixture.invalid/)
    f.setSession()
    await f.controller.command('two', { action: 'view-log' })
    assert.match(f.logs.at(-1)!, /暂无推理记录/)
    assert.doesNotMatch(f.logs.at(-1)!, /开始 AI 字幕/)
  } finally { await f.cleanup() }
})

test('incremental display preserves selection, restores original subtitles and reuses cache', async () => {
  const f = await fixture()
  try {
    await f.controller.command('one', { action: 'start' })
    await until(() => f.controller.snapshot().translatedSeconds === 15 && f.updates.length > 0)
    await f.controller.command('one', { action: 'display', value: 'japanese' })
    await until(() => f.updates.length >= 2)
    assert.equal(f.updates[0].select, true); assert.equal(f.updates.at(-1)?.select, false)
    const filename = f.updates[0].filename
    await f.controller.command('one', { action: 'stop' })
    assert.equal(f.removals[0], 8)
    assert.equal(await fs.access(filename).then(() => true, () => false), false)
    await f.controller.command('one', { action: 'start' })
    await until(() => f.controller.snapshot().translatedSeconds === 15)
    assert.equal(f.recognizes(), 1)
  } finally { await f.cleanup() }
})

test('an asynchronous subtitle command failure is reported and retried without stopping playback or recognition', async () => {
  const f = await fixture()
  try {
    await f.controller.command('one', { action: 'start' })
    await until(() => f.controller.snapshot().translatedSeconds === 15 && f.updates.length > 0)
    f.failSubtitleCommand()
    await f.controller.command('one', { action: 'font-size', value: 50 })
    await until(() => f.controller.snapshot().error !== null)
    assert.match(f.controller.snapshot().error!, /播放不受影响/)
    assert.equal(f.playback().phase, 'playing')
    assert.equal(f.controller.snapshot().enabled, true)
    const updates = f.updates.length
    await f.controller.command('one', { action: 'retry' })
    await until(() => f.updates.length > updates)
    assert.equal(f.recognizes(), 1)
    assert.equal(f.updates.at(-1)?.select, true)
  } finally { await f.cleanup() }
})

test('unrelated subtitle failures do not suspend AI display updates or resurrect warnings after stop', async () => {
  const f = await fixture()
  try {
    await f.controller.command('one', { action: 'start' })
    await until(() => f.controller.snapshot().translatedSeconds === 15)
    f.failManualSubtitleCommand(); f.tick()
    assert.equal(f.controller.snapshot().error, null)
    await f.controller.command('one', { action: 'stop' })
    assert.equal(f.controller.snapshot().error, null)
  } finally { await f.cleanup() }
})

test('a late runtime-read result cannot override a newer model selection or deletion event', async () => {
  const f = await fixture()
  try {
    await until(() => f.controller.snapshot().installed)
    let finish!: (value: boolean) => void
    f.setInstalled(() => new Promise(resolve => { finish = resolve })); f.runtimeChanged()
    f.setInstalled(async () => false); f.runtimeChanged()
    await until(() => !f.controller.snapshot().installed)
    finish(true); await delay(10)
    assert.equal(f.controller.snapshot().installed, false)
    f.setInstalled(async () => true); f.runtimeChanged()
    await until(() => f.controller.snapshot().installed)
  } finally { await f.cleanup() }
})

test('restarting after a precision switch retranslates without recognizing again unless the ASR weight changes', async () => {
  const f = await fixture()
  try {
    await f.controller.command('one', { action: 'start' })
    await until(() => f.controller.snapshot().translatedSeconds === 15)
    await f.controller.command('one', { action: 'stop' })
    f.setVersions('asr-original', 'qwen-new')
    await f.controller.command('one', { action: 'start' })
    await until(() => f.controller.snapshot().translatedSeconds === 15)
    assert.equal(f.recognizes(), 1)
    assert.equal(f.translations(), 2)
    await f.controller.command('one', { action: 'stop' })
    f.setVersions('asr-new', 'qwen-new')
    await f.controller.command('one', { action: 'start' })
    await until(() => f.controller.snapshot().translatedSeconds === 15)
    assert.equal(f.recognizes(), 2)
    assert.equal(f.translations(), 3)
  } finally { await f.cleanup() }
})

test('a session replaced during an ASS write does not drain stale documents before the next tick', async t => {
  const f = await fixture()
  const rename = fs.rename
  let writes = 0
  t.mock.method(fs, 'rename', async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    await rename(from, to)
    if (typeof to === 'string' && to.startsWith(f.root) && to.endsWith('.ass')) {
      writes++
      if (writes === 1) f.setSession()
    }
  })
  try {
    await f.controller.command('one', { action: 'start' })
    await until(() => writes > 0)
    await delay(50)
    assert.equal(writes, 1, 'the old session must not keep rewriting ASS while waiting for a playback tick')
    assert.equal(f.updates.length, 0, 'a stale write must never update the new playback session')
    f.tick()
    await until(() => f.controller.snapshot().sessionId === null)
  } finally { await f.cleanup() }
})

test('audio changes invalidate current work and session replacement stops subtitles', async () => {
  const f = await fixture()
  try {
    await f.controller.command('one', { action: 'start' })
    await until(() => f.controller.snapshot().translatedSeconds === 15)
    f.setAudio(2); f.tick()
    await until(() => f.recognizes() === 2 && f.controller.snapshot().translatedSeconds === 15)
    f.setSession(); f.tick()
    await until(() => f.controller.snapshot().sessionId === null)
    assert.equal(f.controller.snapshot().enabled, false); assert.ok(f.closes() >= 2)
  } finally { await f.cleanup() }
})

test('stop during source preparation prevents late inference and subtitle publication', async () => {
  const f = await fixture()
  let release!: () => void
  f.setResolve(async value => { await new Promise<void>(resolve => { release = resolve }); return value })
  try {
    const start = f.controller.command('one', { action: 'start' })
    await until(() => f.controller.snapshot().phase === 'preparing')
    await f.controller.command('one', { action: 'stop' }); release(); await start
    assert.equal(f.controller.snapshot().enabled, false); assert.equal(f.recognizes(), 0); assert.equal(f.updates.length, 0)
  } finally { await f.cleanup() }
})

test('rapid restart waits for the old shutdown and retains the new model lease and subtitle state', async () => {
  const f = await fixture()
  let releaseClose!: () => void
  try {
    await f.controller.command('one', { action: 'start' })
    await until(() => f.controller.snapshot().translatedSeconds === 15 && f.updates.length > 0)
    f.setClose(() => new Promise<void>(resolve => { releaseClose = resolve }))
    const oldFile = f.updates[0].filename
    const stop = f.controller.command('one', { action: 'stop' })
    await until(() => f.closes() === 1)
    const first = f.controller.command('one', { action: 'start' })
    const second = f.controller.command('one', { action: 'start' })
    await delay(20)
    assert.equal(f.leases(), 1)
    assert.equal(f.controller.snapshot().enabled, false)
    releaseClose()
    await Promise.all([stop, first, second])
    await until(() => f.controller.snapshot().translatedSeconds === 15 && f.updates.some(update => update.filename !== oldFile && update.select))
    assert.equal(f.controller.snapshot().sessionId, 'one')
    assert.equal(f.controller.snapshot().enabled, true)
    assert.equal(f.leases(), 1)
    assert.equal(f.removals.length, 1)
    assert.equal(f.recognizes(), 1)
    f.setClose(async () => {})
    await f.controller.command('one', { action: 'stop' })
    assert.deepEqual(f.removals, [8, 8], 'a restart during shutdown still restores the original subtitle track')
  } finally { releaseClose?.(); f.setClose(async () => {}); await f.cleanup() }
})
